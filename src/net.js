// Network transports. Two implementations share one contract:
//   PeerSession  - WebRTC data channel via PeerJS (direct, preferred)
//   RelaySession - WebSocket through the optional relay worker (fallback)
// Both validate and rate-limit every inbound message and run a heartbeat, so
// game logic never sees a raw frame and never has to trust the peer.
import {
  validateMessage, makeRateLimiter, roomCodeToPeerId, randomRoomCode,
} from './protocol.js';
import { RELAY_URL } from './config.js';

const CONNECT_TIMEOUT_MS = 20000;
const RELAY_TIMEOUT_MS = 10000;
const MAX_RAW_MESSAGE_CHARS = 4096;
// WebRTC close detection can lag by a long time (or never fire when a tab is
// killed), so we run an application-level heartbeat on top of the channel.
const HEARTBEAT_INTERVAL_MS = 2500;
const HEARTBEAT_TIMEOUT_MS = 10000;

export const NAT_HELP = 'Could not open a direct connection between the two devices (strict NAT, VPN or a firewall blocking WebRTC). Try again, switch one player off VPN, or use a different network such as mobile data.';

export function relayEnabled() {
  return typeof RELAY_URL === 'string' && /^wss?:\/\//.test(RELAY_URL);
}

const tagged = (message, type) => Object.assign(new Error(message), { type });

/** Shared plumbing: events, validation, rate limiting, heartbeat. */
class BaseSession {
  constructor() {
    this.role = null; // 'host' | 'guest'
    this.roomCode = null;
    this.handlers = { message: [], open: [], close: [], error: [], status: [] };
    this.allow = makeRateLimiter();
    this.closed = false;
    this.lastSeen = 0;
    this.heartbeat = null;
  }

  on(evt, fn) { this.handlers[evt].push(fn); return this; }
  emit(evt, ...args) {
    for (const fn of this.handlers[evt]) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }

  get connected() { return !this.closed && this._isOpen(); }

  _startHeartbeat() {
    this.lastSeen = Date.now();
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.closed) { clearInterval(this.heartbeat); return; }
      if (Date.now() - this.lastSeen > HEARTBEAT_TIMEOUT_MS) { this._lost(); return; }
      this.send({ t: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Peer is gone (clean close, or heartbeat timeout). Emits 'close' exactly once. */
  _lost() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this._rawClose();
    this.emit('close');
  }

  /** Every inbound frame passes through here. Accepts decoded objects or JSON strings. */
  _onData(raw) {
    if (!this.allow()) return; // flood: drop silently
    let obj = raw;
    if (typeof raw === 'string') {
      if (raw.length > MAX_RAW_MESSAGE_CHARS) return;
      try { obj = JSON.parse(raw); } catch { return; }
    } else {
      if (!raw || typeof raw !== 'object' || ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) return;
      let size = 0;
      try { size = JSON.stringify(raw).length; } catch { return; }
      if (size > MAX_RAW_MESSAGE_CHARS) return;
    }
    const msg = validateMessage(obj);
    if (!msg) return;
    this.lastSeen = Date.now();
    if (msg.t === 'ping') { this.send({ t: 'pong' }); return; }
    if (msg.t === 'pong') return;
    this.emit('message', msg);
  }

  send(msg) {
    if (this.closed || !this._isOpen()) return false;
    // Validate outbound too: we never send something the other side would reject.
    const clean = validateMessage(msg);
    if (!clean) { console.error('refusing to send malformed message', msg); return false; }
    try { this._rawSend(clean); return true; } catch { return false; }
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    this._rawClose();
  }

  // Transport hooks
  _isOpen() { return false; }
  _rawSend() { throw new Error('not connected'); }
  _rawClose() { /* override */ }
}

// ---------------------------------------------------------------------------
// WebRTC via PeerJS
// ---------------------------------------------------------------------------
function getPeerCtor() {
  const P = globalThis.Peer;
  if (typeof P !== 'function') throw new Error('PeerJS failed to load');
  return P;
}

export class PeerSession extends BaseSession {
  constructor() {
    super();
    this.transport = 'p2p';
    this.peer = null;
    this.conn = null;
  }

  _isOpen() { return Boolean(this.conn && this.conn.open); }
  _rawSend(obj) { this.conn.send(obj); }
  _rawClose() {
    try { this.conn?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.conn = null;
    this.peer = null;
  }

  /** Host: claim the room id on the signalling server. Resolves when listening. */
  host(code) {
    return new Promise((resolve, reject) => {
      const Peer = getPeerCtor();
      this.role = 'host';
      this.roomCode = code;
      const peer = new Peer(roomCodeToPeerId(code), peerOptions());
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        peer.destroy();
        reject(tagged('Signalling server timeout. Check your connection.', 'timeout'));
      }, CONNECT_TIMEOUT_MS);
      // Bootstrap-only error handler; detached once the id is claimed so a
      // later transient signalling error cannot tear down a live match.
      const onBootError = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(tagged(describePeerError(e), e?.type));
      };
      peer.on('error', onBootError);
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onBootError);
        this.peer = peer;
        peer.on('connection', (conn) => {
          if (this.conn || this.closed) { try { conn.close(); } catch { /* ignore */ } return; } // one opponent only
          this.emit('status', 'Opponent found, opening a direct connection…');
          this._attach(conn);
        });
        peer.on('error', (e) => this._peerError(e));
        resolve(code);
      });
    });
  }

  /** Guest: connect to a host's room code. */
  join(code) {
    return new Promise((resolve, reject) => {
      const Peer = getPeerCtor();
      this.role = 'guest';
      this.roomCode = code;
      const peer = new Peer(undefined, peerOptions());
      let settled = false;
      let sawIce = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch { /* ignore */ }
        reject(err);
      };
      const timer = setTimeout(() => fail(sawIce
        ? tagged(NAT_HELP, 'nat')
        : tagged('No room with that code answered. Check the code and that the host is still waiting.', 'peer-unavailable')), CONNECT_TIMEOUT_MS);
      peer.on('open', () => {
        this.peer = peer;
        this.emit('status', 'Signalling server reached. Looking for the room…');
        const conn = peer.connect(roomCodeToPeerId(code), { reliable: true, serialization: 'json' });
        conn.on('iceStateChanged', (state) => {
          if (settled) return;
          sawIce = true;
          if (state === 'checking') this.emit('status', 'Room found. Opening a direct connection…');
          if (state === 'failed' || state === 'disconnected') fail(tagged(NAT_HELP, 'nat'));
        });
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          peer.on('error', (e) => this._peerError(e));
          this._attach(conn, true);
          resolve();
        });
        conn.on('error', (e) => fail(sawIce ? tagged(NAT_HELP, 'nat') : tagged(describePeerError(e), e?.type)));
        peer.on('error', (e) => fail(tagged(describePeerError(e), e?.type)));
      });
      peer.on('error', (e) => fail(tagged(describePeerError(e), e?.type)));
    });
  }

  _attach(conn, alreadyOpen = false) {
    // The *connecting* peer picks the serialization. Only JSON is acceptable:
    // BinaryPack chunk reassembly in PeerJS buffers without bound.
    if (conn.serialization !== 'json') { try { conn.close(); } catch { /* ignore */ } return; }
    this.conn = conn;
    conn.on('data', (raw) => this._onData(raw));
    conn.on('close', () => this._lost());
    conn.on('iceStateChanged', (state) => { if (state === 'failed') this._lost(); });
    conn.on('error', (e) => this.emit('error', new Error(describePeerError(e))));
    const onOpen = () => { this._startHeartbeat(); this.emit('open'); };
    if (alreadyOpen) onOpen();
    else conn.on('open', onOpen);
  }

  _peerError(e) {
    if (e?.type === 'peer-unavailable') return; // benign
    this.emit('error', new Error(describePeerError(e)));
  }
}

function peerOptions() {
  // Public PeerJS cloud signalling. Game data never transits it; only the
  // SDP/ICE handshake does. STUN only: when no direct path exists the game
  // falls back to the relay worker (src/config.js), if one is configured.
  return {
    debug: 0,
    config: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
      iceCandidatePoolSize: 2,
    },
  };
}

function describePeerError(e) {
  switch (e?.type) {
    case 'peer-unavailable': return 'No room with that code is open right now.';
    case 'network': return 'Network problem reaching the signalling server.';
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    case 'unavailable-id': return 'Room code collision, please try again.';
    case 'server-error': return 'Signalling server error. Try again shortly.';
    case 'socket-error':
    case 'socket-closed': return 'Connection to signalling server dropped.';
    case 'webrtc': return NAT_HELP;
    default: return 'Connection error.';
  }
}

// ---------------------------------------------------------------------------
// WebSocket relay (fallback)
// ---------------------------------------------------------------------------
export class RelaySession extends BaseSession {
  constructor() {
    super();
    this.transport = 'relay';
    this.ws = null;
    this.paired = false;
  }

  _isOpen() { return Boolean(this.ws && this.ws.readyState === 1 && this.paired); }
  _rawSend(obj) { this.ws.send(JSON.stringify(obj)); }
  _rawClose() {
    try { this.ws?.close(1000, 'bye'); } catch { /* ignore */ }
    this.ws = null;
  }

  _url(code, role) {
    const base = RELAY_URL.replace(/\/+$/, '');
    return `${base}/room/${encodeURIComponent(code)}?role=${role}`;
  }

  host(code) { return this._connect(code, 'host'); }
  join(code) { return this._connect(code, 'guest'); }

  /**
   * Host resolves once the room is registered ('ready'); guest resolves once
   * both sides are present ('paired'). 'open' fires on pairing for both.
   */
  _connect(code, role) {
    return new Promise((resolve, reject) => {
      if (!relayEnabled()) { reject(new Error('Relay not configured.')); return; }
      this.role = role;
      this.roomCode = code;
      let ws;
      try { ws = new WebSocket(this._url(code, role)); } catch { reject(new Error('Relay unavailable.')); return; }
      this.ws = ws;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        this.ws = null;
        reject(err);
      };
      const ok = () => { settled = true; clearTimeout(timer); resolve(code); };
      const timer = setTimeout(() => fail(new Error('Relay server did not answer.')), RELAY_TIMEOUT_MS);
      ws.addEventListener('error', () => fail(new Error('Could not reach the relay server.')));
      ws.addEventListener('close', (evt) => {
        if (!settled) { fail(new Error(closeReason(evt))); return; }
        this._lost();
      });
      ws.addEventListener('message', (evt) => {
        const data = evt.data;
        if (typeof data !== 'string' || data.length > MAX_RAW_MESSAGE_CHARS) return;
        if (data.startsWith('{"sys"')) {
          let sys = null;
          try { sys = JSON.parse(data).sys; } catch { return; }
          this._onSys(sys, ok, fail);
          return;
        }
        this._onData(data);
      });
    });
  }

  _onSys(sys, ok, fail) {
    switch (sys) {
      case 'ready': // host registered, waiting for a guest
        if (this.role === 'host') ok();
        return;
      case 'paired':
        this.paired = true;
        if (this.role === 'guest') ok();
        this._startHeartbeat();
        this.emit('open');
        return;
      case 'no-room': fail(tagged('No room with that code is open on the relay.', 'peer-unavailable')); return;
      case 'full': fail(new Error('That room already has two players.')); return;
      case 'peer-left': this._lost(); return;
      default: return;
    }
  }
}

function closeReason(evt) {
  switch (evt?.reason) {
    case 'no-room': return 'No room with that code is open on the relay.';
    case 'full': return 'That room already has two players.';
    case 'idle': return 'The room expired.';
    default: return 'Relay connection closed.';
  }
}

// ---------------------------------------------------------------------------
// Composite: the host listens on both transports under one room code and the
// first one the guest reaches wins. The guest tries direct first, then relay.
// ---------------------------------------------------------------------------
export class NetSession extends BaseSession {
  constructor() {
    super();
    this.inner = null; // the transport that actually connected
    this.candidates = [];
  }

  get transport() { return this.inner ? this.inner.transport : 'none'; }

  _isOpen() { return Boolean(this.inner && this.inner._isOpen()); }
  _rawSend(obj) { this.inner._rawSend(obj); }
  _rawClose() {
    for (const c of this.candidates) { try { c.close(); } catch { /* ignore */ } }
    this.candidates = [];
    this.inner = null;
  }

  /** Inbound frames are already validated and heartbeat-handled by the inner session. */
  _adopt(session) {
    if (this.inner || this.closed) { try { session.close(); } catch { /* ignore */ } return; }
    this.inner = session;
    this.role = session.role;
    this.roomCode = session.roomCode;
    for (const c of this.candidates) if (c !== session) { try { c.close(); } catch { /* ignore */ } }
    this.candidates = [session];
    session.on('message', (m) => this.emit('message', m));
    session.on('close', () => this._lost());
    session.on('error', (e) => this.emit('error', e));
    this.emit('open');
  }

  _wire(session) {
    session.on('status', (t) => { if (!this.inner) this.emit('status', t); });
    session.on('open', () => this._adopt(session));
    this.candidates.push(session);
  }

  _forget(session) {
    this.candidates = this.candidates.filter((c) => c !== session);
    try { session.close(); } catch { /* ignore */ }
  }

  /** Host: listen on WebRTC and (if configured) the relay under one code. */
  async host() {
    this.role = 'host';
    let code = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = randomRoomCode();
      const p2p = new PeerSession();
      this._wire(p2p);
      try {
        await p2p.host(candidate);
        code = candidate;
      } catch (e) {
        lastErr = e;
        this._forget(p2p);
        if (e?.type !== 'unavailable-id') break;
      }
    }
    if (!code) throw lastErr || new Error('Could not create a room.');
    this.roomCode = code;
    if (relayEnabled()) {
      const relay = new RelaySession();
      this._wire(relay);
      relay.host(code).catch(() => this._forget(relay));
    }
    return code;
  }

  /** Guest: direct first, relay second. */
  async join(code) {
    this.role = 'guest';
    this.roomCode = code;
    // ?transport=relay skips the direct attempt (debugging / known-bad networks).
    const forceRelay = relayEnabled() && new URLSearchParams(globalThis.location?.search ?? '').get('transport') === 'relay';
    const p2p = new PeerSession();
    if (!forceRelay) this._wire(p2p);
    try {
      if (forceRelay) throw tagged('Relay forced by ?transport=relay', 'nat');
      await p2p.join(code);
      return;
    } catch (e) {
      this._forget(p2p);
      if (!relayEnabled()) throw e;
      this.emit('status', 'Direct connection failed. Trying the relay…');
      const relay = new RelaySession();
      this._wire(relay);
      try {
        await relay.join(code);
      } catch (e2) {
        this._forget(relay);
        // "No room" from the relay means the host is gone (or on an old client);
        // otherwise the NAT explanation is the more useful one.
        throw e2?.type === 'peer-unavailable' && e?.type === 'nat' ? e2 : (e?.type === 'nat' ? e : e2);
      }
    }
  }
}
