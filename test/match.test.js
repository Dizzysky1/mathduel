import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, buildQuestions, cpuPlan, MAX_SUDDEN_DEATH } from '../src/match.js';
import { formatAnswer } from '../src/questions.js';
import { mulberry32, makeRandom } from '../src/rng.js';

const correctInput = (q) => String(q.answer);

test('buildQuestions is deterministic and sized', () => {
  const a = buildQuestions(123, '9', 15);
  const b = buildQuestions(123, '9', 15);
  assert.deepEqual(a, b);
  assert.equal(a.length, 15);
  assert.notDeepEqual(buildQuestions(124, '9', 15), a);
});

test('first correct answer scores, wrong answer locks out', () => {
  const m = new Match({ seed: 7, grade: 'mixed', rounds: 5 });
  assert.ok(m.next());
  const q = m.current;
  const wrong = q.kind === 'choice' ? String((q.answer + 1) % 4) : 'nonsense';
  let r = m.submit('a', wrong);
  assert.equal(r.accepted, true); assert.equal(r.correct, false); assert.equal(m.locked.a, true);
  r = m.submit('a', correctInput(q));
  assert.equal(r.accepted, false); assert.equal(r.lockedOut, true);
  r = m.submit('b', correctInput(q));
  assert.equal(r.won, true);
  assert.equal(m.phase, 'reveal');
  assert.deepEqual(m.scores, { a: 0, b: 1 });
  assert.equal(m.submit('b', '1').accepted, false); // late submissions ignored
});

test('both wrong ends the question with no winner; timeout too', () => {
  const m = new Match({ seed: 9, grade: '8', rounds: 5 });
  m.next();
  m.submit('a', 'x'); m.submit('b', 'y');
  assert.equal(m.phase, 'reveal'); assert.equal(m.winner, null);
  m.next();
  m.timeout();
  assert.equal(m.phase, 'reveal');
  assert.equal(m.history.length, 2);
});

test('match ends after rounds when not tied; sudden death when tied', () => {
  const m = new Match({ seed: 1, grade: '10', rounds: 5 });
  for (let i = 0; i < 5; i++) { assert.ok(m.next()); assert.ok(m.submit('a', correctInput(m.current)).won); }
  assert.equal(m.next(), false);
  assert.equal(m.phase, 'over');
  assert.equal(m.result, 'a');

  const t = new Match({ seed: 2, grade: '10', rounds: 4 });
  for (let i = 0; i < 4; i++) { t.next(); assert.ok(t.submit(i % 2 ? 'a' : 'b', correctInput(t.current)).won); }
  assert.ok(t.next()); // sudden death
  assert.equal(t.isSuddenDeath, true);
  t.submit('b', correctInput(t.current));
  assert.equal(t.next(), false);
  assert.equal(t.result, 'b');
});

test('sudden death is capped', () => {
  const m = new Match({ seed: 3, grade: '11', rounds: 5 });
  let count = 0;
  while (m.next()) { m.timeout(); count++; }
  assert.equal(count, 5 + MAX_SUDDEN_DEATH);
  assert.equal(m.result, null);
});

test('applyExternal mirrors host result', () => {
  const m = new Match({ seed: 4, grade: '12', rounds: 5 });
  m.next();
  m.applyExternal('a', { a: '1', b: null });
  assert.deepEqual(m.scores, { a: 1, b: 0 });
  assert.equal(m.phase, 'reveal');
  m.applyExternal('b', { a: null, b: '1' }); // ignored in reveal phase
  assert.deepEqual(m.scores, { a: 1, b: 0 });
});

test('cpuPlan produces a valid answer string within the time limit', () => {
  const R = makeRandom(mulberry32(5));
  const qs = buildQuestions(5, 'mixed', 200);
  for (const q of qs) {
    for (const d of ['easy', 'normal', 'hard']) {
      const p = cpuPlan(R, d, q, 20000);
      assert.ok(p.delay >= 0 && p.delay < 20000);
      assert.equal(typeof p.value, 'string');
      assert.ok(p.value.length <= 32);
      assert.equal(typeof formatAnswer(q), 'string');
    }
  }
});
