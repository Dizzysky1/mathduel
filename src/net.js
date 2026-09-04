// Thin wrapper over PeerJS. Exposes a tiny event API and enforces that every
// inbound message is validated and rate-limited before reaching game logic.
import {
  validateMessage, makeRateLimiter, roomCodeToPeerId, randomRoomCode,
} from './protocol.js';

const CONNECT_TIMEOUT_MS = 15000;
const MAX_RAW_MESSAGE_CHARS = 4096;

function getPeerCtor() {
  const P = globalThis.Peer;
  if (typeof P !== 'function') throw new Error('PeerJS failed to load');
  return P;
}

export class NetSession {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.role = null; // 'host' | 'guest'
    this.roomCode = null;
    this.handlers = { message: [], open: [], close: [], error: [] };
    this.allow = makeRateLimiter();
    this.closed = false;
  }

  on(evt, fn) { this.handlers[evt].push(fn); return this; }
  emit(evt, ...args) {
    for (const fn of this.handlers[evt]) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }

  /** Host: claim a random room id on the signalling server; resolves with the room code. */
  host() {
    return new Promise((resolve, reject) => {
      const Peer = getPeerCtor();
      this.role = 'host';
      let attempts = 0;
      const tryCode = () => {
        attempts++;
        const code = randomRoomCode();
        const peer = new Peer(roomCodeToPeerId(code), peerOptions());
        const timer = setTimeout(() => {
          peer.destroy();
          reject(new Error('Signalling server timeout. Check your connection.'));
        }, CONNECT_TIMEOUT_MS);
        peer.on('open', () => {
          clearTimeout(timer);
          this.peer = peer;
          this.roomCode = code;
          peer.on('connection', (conn) => {
            if (this.conn) { try { conn.close(); } catch { /* ignore */ } return; } // one opponent only
            this._attach(conn);
          });
          peer.on('error', (e) => this._peerError(e));
          resolve(code);
        });
        peer.on('error', (e) => {
          clearTimeout(timer);
          if (e?.type === 'unavailable-id' && attempts < 5) { peer.destroy(); tryCode(); return; }
          peer.destroy();
          reject(new Error(describePeerError(e)));
        });
      };
      tryCode();
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
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch { /* ignore */ }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('Could not reach that room. Check the code and try again.')), CONNECT_TIMEOUT_MS);
      peer.on('open', () => {
        this.peer = peer;
        const conn = peer.connect(roomCodeToPeerId(code), { reliable: true, serialization: 'json' });
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          peer.on('error', (e) => this._peerError(e));
          this._attach(conn, true);
          resolve();
        });
        conn.on('error', (e) => fail(new Error(describePeerError(e))));
        peer.on('error', (e) => fail(new Error(describePeerError(e))));
      });
      peer.on('error', (e) => fail(new Error(describePeerError(e))));
    });
  }

  _attach(conn, alreadyOpen = false) {
    this.conn = conn;
    conn.on('data', (raw) => this._onData(raw));
    conn.on('close', () => { if (!this.closed) { this.closed = true; this.emit('close'); } });
    conn.on('error', (e) => this.emit('error', new Error(describePeerError(e))));
    if (alreadyOpen) this.emit('open');
    else conn.on('open', () => this.emit('open'));
  }

  _peerError(e) {
    if (e?.type === 'peer-unavailable') return; // benign
    this.emit('error', new Error(describePeerError(e)));
  }

  _onData(raw) {
    if (!this.allow()) return; // flood: drop silently
    let obj = raw;
    if (typeof raw === 'string') {
      if (raw.length > MAX_RAW_MESSAGE_CHARS) return;
      try { obj = JSON.parse(raw); } catch { return; }
    } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      return; // binary is never valid for this protocol
    }
    const msg = validateMessage(obj);
    if (!msg) return;
    this.emit('message', msg);
  }

  send(msg) {
    if (!this.conn || !this.conn.open) return false;
    // Validate outbound too: we never send something the other side would reject.
    const clean = validateMessage(msg);
    if (!clean) { console.error('refusing to send malformed message', msg); return false; }
    try { this.conn.send(clean); return true; } catch { return false; }
  }

  close() {
    this.closed = true;
    try { this.conn?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.conn = null;
    this.peer = null;
  }
}

function peerOptions() {
  // Public PeerJS cloud signalling. Game data never transits it; only the
  // SDP/ICE handshake does. STUN only (no TURN) - symmetric NATs may fail.
  return {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
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
    case 'webrtc': return 'WebRTC connection failed (firewall or NAT).';
    default: return 'Connection error.';
  }
}
