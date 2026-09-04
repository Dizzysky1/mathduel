import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMessage, sanitizeName, normalizeRoomCode, makeRateLimiter,
  randomRoomCode, randomNonceHex, sha256Hex, PROTOCOL_VERSION,
} from '../src/protocol.js';

const hex32 = 'a'.repeat(32);
const hex64 = 'b'.repeat(64);

test('rejects garbage', () => {
  for (const bad of [null, undefined, 1, 'x', [], {}, { t: 'nope' }, { t: 1 }, { t: 'hello' }, { t: 'answer', q: 'x' }]) {
    assert.equal(validateMessage(bad), null);
  }
});

test('hello / hello_ack require version and hex fields', () => {
  assert.equal(validateMessage({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'a', commit: hex64 }), null);
  assert.equal(validateMessage({ t: 'hello', v: PROTOCOL_VERSION, name: 'a', commit: 'zz' }), null);
  const ok = validateMessage({ t: 'hello', v: PROTOCOL_VERSION, name: '  Bob<script>  ', commit: hex64, extra: 1 });
  assert.deepEqual(ok, { t: 'hello', v: PROTOCOL_VERSION, name: 'Bob<script>', commit: hex64 });
  assert.equal(validateMessage({ t: 'hello_ack', v: PROTOCOL_VERSION, name: 'x', nonce: hex64 }), null);
  assert.ok(validateMessage({ t: 'hello_ack', v: PROTOCOL_VERSION, name: 'x', nonce: hex32 }));
});

test('start bounds', () => {
  const base = { t: 'start', nonce: hex32, grade: '10', rounds: 10, timeLimit: 20 };
  assert.ok(validateMessage(base));
  assert.equal(validateMessage({ ...base, grade: '13' }), null);
  assert.equal(validateMessage({ ...base, grade: 10 }), null);
  assert.equal(validateMessage({ ...base, rounds: 1000 }), null);
  assert.equal(validateMessage({ ...base, rounds: 10.5 }), null);
  assert.equal(validateMessage({ ...base, timeLimit: 0 }), null);
});

test('answer / result / next / gameover bounds', () => {
  assert.ok(validateMessage({ t: 'answer', q: 0, value: '3/4' }));
  assert.equal(validateMessage({ t: 'answer', q: -1, value: '1' }), null);
  assert.equal(validateMessage({ t: 'answer', q: 100, value: '1' }), null);
  assert.equal(validateMessage({ t: 'answer', q: 1, value: 'x'.repeat(33) }), null);
  assert.equal(validateMessage({ t: 'answer', q: 1, value: 5 }), null);
  assert.ok(validateMessage({ t: 'result', q: 2, winner: null, hostAns: null, guestAns: '1' }));
  assert.ok(validateMessage({ t: 'result', q: 2, winner: 'host', hostAns: '1', guestAns: null }));
  assert.equal(validateMessage({ t: 'result', q: 2, winner: 'me', hostAns: null, guestAns: null }), null);
  assert.equal(validateMessage({ t: 'result', q: 2, winner: 'host', hostAns: 7, guestAns: null }), null);
  assert.equal(validateMessage({ t: 'result', q: 2, winner: 'host' }), null); // undefined answers
  assert.ok(validateMessage({ t: 'next', q: 5 }));
  assert.equal(validateMessage({ t: 'next', q: '5' }), null);
  assert.ok(validateMessage({ t: 'gameover', host: 3, guest: 7 }));
  assert.equal(validateMessage({ t: 'gameover', host: -1, guest: 7 }), null);
});

test('prototype pollution shaped input is harmless', () => {
  const m = JSON.parse('{"t":"next","q":1,"__proto__":{"polluted":true}}');
  const out = validateMessage(m);
  assert.deepEqual(out, { t: 'next', q: 1 });
  assert.equal({}.polluted, undefined);
});

test('sanitizeName strips control/bidi chars and clamps', () => {
  assert.equal(sanitizeName('ab\u202ecd e\u200b'), 'abcd e');
  assert.equal(sanitizeName('a\u0000b\u001fc\u007fd'), 'abcd');
  assert.equal(sanitizeName('x'.repeat(100)).length, 16);
  assert.equal(sanitizeName('   '), 'Player');
  assert.equal(sanitizeName(42), 'Player');
  assert.equal(sanitizeName('a\n\n b'), 'a b');
  assert.equal(sanitizeName('\ufeff'), 'Player');
});

test('room code normalisation', () => {
  assert.equal(normalizeRoomCode(' ab-cd ef '), 'ABCDEF');
  assert.equal(normalizeRoomCode('ABCDEO'), null); // O is not in the alphabet
  assert.equal(normalizeRoomCode('ABCDE1'), null); // nor is 1
  assert.equal(normalizeRoomCode('ABCDE'), null);
  assert.equal(normalizeRoomCode('ABCDEFG'), null);
  assert.equal(normalizeRoomCode(null), null);
  for (let i = 0; i < 50; i++) { const c = randomRoomCode(); assert.equal(normalizeRoomCode(c), c); }
});

test('nonce + commit', async () => {
  const n = randomNonceHex();
  assert.match(n, /^[0-9a-f]{32}$/);
  const c = await sha256Hex(n);
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('rate limiter drops floods and refills', () => {
  const allow = makeRateLimiter({ capacity: 5, refillPerSec: 10 });
  let t = 1000;
  for (let i = 0; i < 5; i++) assert.equal(allow(t), true);
  assert.equal(allow(t), false);
  t += 200; // +2 tokens
  assert.equal(allow(t), true);
  assert.equal(allow(t), true);
  assert.equal(allow(t), false);
});
