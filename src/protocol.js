// Wire protocol for online matches. Every inbound message from the peer is
// untrusted and MUST pass validateMessage() before the game looks at it.

export const PROTOCOL_VERSION = 2;
export const NAME_MAX = 16;
export const ANSWER_MAX = 32;
export const ROUNDS_MIN = 5;
export const ROUNDS_MAX = 20;
export const MAX_QUESTION_INDEX = 99;
export const GRADE_OPTIONS = ['8', '9', '10', '11', '12', 'mixed'];
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const PEER_ID_PREFIX = 'mathduel-v2-';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
// Control chars, zero-width chars, bidi overrides, BOM.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/** Strip control chars / bidi overrides and clamp a display name. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw
    .slice(0, 256)
    .replace(UNSAFE_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return cleaned.length ? cleaned : 'Player';
}

export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw
    .slice(0, 64)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return ROOM_RE.test(code) ? code : null;
}

export function roomCodeToPeerId(code) {
  return PEER_ID_PREFIX + code;
}

/** Cryptographically random room code (30 bits of entropy). */
export function randomRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
}

export function randomNonceHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Message schemas. Returns the validated message (with unknown fields dropped)
 * or null if the message is malformed. Never throws.
 */
export function validateMessage(msg) {
  try {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    const t = msg.t;
    switch (t) {
      case 'hello': // host -> guest
        if (msg.v !== PROTOCOL_VERSION) return null;
        if (!isStr(msg.name, 256) || !isStr(msg.commit, 64) || !HEX64.test(msg.commit)) return null;
        return { t, v: msg.v, name: sanitizeName(msg.name), commit: msg.commit };
      case 'hello_ack': // guest -> host
        if (msg.v !== PROTOCOL_VERSION) return null;
        if (!isStr(msg.name, 256) || !isStr(msg.nonce, 32) || !HEX32.test(msg.nonce)) return null;
        return { t, v: msg.v, name: sanitizeName(msg.name), nonce: msg.nonce };
      case 'start': // host -> guest
        if (!isStr(msg.nonce, 32) || !HEX32.test(msg.nonce)) return null;
        if (!GRADE_OPTIONS.includes(msg.grade)) return null;
        if (!isInt(msg.rounds, ROUNDS_MIN, ROUNDS_MAX)) return null;
        if (!isInt(msg.timeLimit, 5, 120)) return null;
        return { t, nonce: msg.nonce, grade: msg.grade, rounds: msg.rounds, timeLimit: msg.timeLimit };
      case 'answer': // guest -> host
        if (!isInt(msg.q, 0, MAX_QUESTION_INDEX)) return null;
        if (!isStr(msg.value, ANSWER_MAX)) return null;
        return { t, q: msg.q, value: msg.value };
      case 'result': // host -> guest
        if (!isInt(msg.q, 0, MAX_QUESTION_INDEX)) return null;
        if (!['host', 'guest', null].includes(msg.winner)) return null;
        if (msg.hostAns !== null && !isStr(msg.hostAns, ANSWER_MAX)) return null;
        if (msg.guestAns !== null && !isStr(msg.guestAns, ANSWER_MAX)) return null;
        return { t, q: msg.q, winner: msg.winner, hostAns: msg.hostAns, guestAns: msg.guestAns };
      case 'next': // host -> guest
        if (!isInt(msg.q, 0, MAX_QUESTION_INDEX)) return null;
        return { t, q: msg.q };
      case 'gameover': // host -> guest
        if (!isInt(msg.host, 0, 1000) || !isInt(msg.guest, 0, 1000)) return null;
        return { t, host: msg.host, guest: msg.guest };
      case 'ready': // guest -> host: mirror built, send the first question
      case 'rematch': // either direction
      case 'ping':
      case 'pong':
        return { t };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Simple token bucket for inbound message rate limiting. */
export function makeRateLimiter({ capacity = 40, refillPerSec = 20 } = {}) {
  let tokens = capacity;
  let last = Date.now();
  return function allow(now = Date.now()) {
    const elapsed = Math.max(0, now - last) / 1000;
    last = now;
    tokens = Math.min(capacity, tokens + elapsed * refillPerSec);
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
