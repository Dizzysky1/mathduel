// MathDuel relay: a tiny Cloudflare Worker + Durable Object that forwards
// text frames between exactly two WebSockets (host + guest) sharing a room
// code. Used only when the peers cannot open a direct WebRTC channel.
// It never inspects or stores game data; frames are opaque, size-capped strings.

const ROOM_RE = /^\/room\/([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6})$/;
const MAX_FRAME_CHARS = 4096;
const HOST_ALONE_TTL_MS = 15 * 60 * 1000;
const RATE_CAPACITY = 40;
const RATE_REFILL_PER_SEC = 20;

function originAllowed(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(origin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('MathDuel relay OK', { headers: { 'content-type': 'text/plain' } });
    }
    const m = url.pathname.match(ROOM_RE);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!originAllowed(req, env)) return new Response('forbidden origin', { status: 403 });
    const id = env.ROOMS.idFromName(m[1]);
    return env.ROOMS.get(id).fetch(req);
  },
};

function makeRateLimiter() {
  let tokens = RATE_CAPACITY;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(RATE_CAPACITY, tokens + ((now - last) / 1000) * RATE_REFILL_PER_SEC);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export class Room {
  constructor(state) {
    this.state = state;
    this.host = null;
    this.guest = null;
    this.ttl = null;
  }

  async fetch(req) {
    const role = new URL(req.url).searchParams.get('role');
    if (role !== 'host' && role !== 'guest') return new Response('bad role', { status: 400 });
    if (role === 'host' && this.host) return new Response('room taken', { status: 409 });
    if (role === 'guest' && !this.host) return this.reject('no-room');
    if (role === 'guest' && this.guest) return this.reject('full');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const sock = { ws: server, role, allow: makeRateLimiter() };
    this[role] = sock;

    server.addEventListener('message', (evt) => this.onMessage(sock, evt));
    server.addEventListener('close', () => this.onClose(sock));
    server.addEventListener('error', () => this.onClose(sock));

    if (role === 'host') {
      this.send(sock, { sys: 'ready' });
      this.armTtl();
    } else {
      clearTimeout(this.ttl);
      this.send(this.host, { sys: 'paired' });
      this.send(sock, { sys: 'paired' });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  reject(reason) {
    // Accept then immediately tell the client why, so the browser gets a
    // readable reason instead of an opaque handshake failure.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.send(JSON.stringify({ sys: reason }));
    server.close(1000, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  armTtl() {
    clearTimeout(this.ttl);
    this.ttl = setTimeout(() => { if (this.host && !this.guest) this.drop(this.host, 'idle'); }, HOST_ALONE_TTL_MS);
  }

  send(sock, obj) {
    try { sock?.ws.send(JSON.stringify(obj)); } catch { /* peer gone */ }
  }

  onMessage(sock, evt) {
    if (!sock.allow()) return;
    const data = evt.data;
    if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) { this.drop(sock, 'bad-frame'); return; }
    if (data.startsWith('{"sys"')) return; // clients may not forge system frames
    const other = sock.role === 'host' ? this.guest : this.host;
    if (!other) return;
    try { other.ws.send(data); } catch { this.onClose(other); }
  }

  drop(sock, reason) {
    try { sock.ws.close(1000, reason); } catch { /* ignore */ }
    this.onClose(sock);
  }

  onClose(sock) {
    if (this[sock.role] !== sock) return;
    this[sock.role] = null;
    const other = sock.role === 'host' ? this.guest : this.host;
    if (other) {
      this.send(other, { sys: 'peer-left' });
      try { other.ws.close(1000, 'peer-left'); } catch { /* ignore */ }
      this[other.role] = null;
    }
    clearTimeout(this.ttl);
  }
}
