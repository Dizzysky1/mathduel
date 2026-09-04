// Match state machine. Pure logic, no DOM, no network. The online host runs
// this as the authority; the guest runs a mirror of it and verifies every
// claim the host makes against its own copy of the questions.
import { mulberry32, makeRandom } from './rng.js';
import { generateQuestion, checkAnswer } from './questions.js';

export const MAX_SUDDEN_DEATH = 5;
export const DEFAULT_ROUNDS = 10;
export const DEFAULT_TIME_LIMIT = 20;

/** Deterministically build the full question list for a match. */
export function buildQuestions(seed, grade, count) {
  const R = makeRandom(mulberry32(seed));
  const g = grade === 'mixed' ? 'mixed' : Number(grade);
  const out = [];
  const seenPrompts = new Set();
  for (let i = 0; i < count; i++) {
    let q = generateQuestion(R, g);
    // Avoid exact duplicate prompts inside one match (bounded retries).
    for (let tries = 0; tries < 20 && seenPrompts.has(q.prompt); tries++) q = generateQuestion(R, g);
    seenPrompts.add(q.prompt);
    out.push(q);
  }
  return out;
}

/**
 * A race match between players 'a' and 'b'. Both see the same question; the
 * first correct answer scores. A wrong answer locks that player out of the
 * current question. Ties after `rounds` go to sudden death.
 */
export class Match {
  constructor({ seed, grade, rounds = DEFAULT_ROUNDS, timeLimit = DEFAULT_TIME_LIMIT }) {
    this.grade = grade;
    this.rounds = rounds;
    this.timeLimit = timeLimit;
    this.questions = buildQuestions(seed, grade, rounds + MAX_SUDDEN_DEATH);
    this.scores = { a: 0, b: 0 };
    this.index = -1;
    this.phase = 'idle'; // idle | question | reveal | over
    this.locked = { a: false, b: false };
    this.answers = { a: null, b: null };
    this.winner = null; // per-question winner
    this.history = [];
  }

  get current() { return this.questions[this.index] ?? null; }
  get isSuddenDeath() { return this.index >= this.rounds; }
  get totalPlanned() { return this.rounds; }

  /** Advance to the next question. Returns false if the match is over. */
  next() {
    if (this.phase === 'over') return false;
    const nextIndex = this.index + 1;
    if (this._isFinished(nextIndex)) { this.phase = 'over'; return false; }
    this.index = nextIndex;
    this.phase = 'question';
    this.locked = { a: false, b: false };
    this.answers = { a: null, b: null };
    this.winner = null;
    return true;
  }

  _isFinished(nextIndex) {
    if (nextIndex < this.rounds) return false;
    // Regulation over: finished unless tied, and cap sudden death.
    if (this.scores.a !== this.scores.b) return true;
    return nextIndex >= this.rounds + MAX_SUDDEN_DEATH;
  }

  /**
   * Player `who` submits `value`. Returns
   * { accepted, correct, won, lockedOut } - `won` means they took the point.
   */
  submit(who, value) {
    if (this.phase !== 'question') return { accepted: false, correct: false, won: false, lockedOut: false };
    if (this.locked[who]) return { accepted: false, correct: false, won: false, lockedOut: true };
    const correct = checkAnswer(this.current, value);
    this.answers[who] = String(value).slice(0, 32);
    this.locked[who] = true;
    if (correct && this.winner === null) {
      this.winner = who;
      this.scores[who] += 1;
      this._endQuestion();
      return { accepted: true, correct: true, won: true, lockedOut: false };
    }
    if (this.locked.a && this.locked.b) this._endQuestion();
    return { accepted: true, correct, won: false, lockedOut: false };
  }

  /** Time limit expired with no winner. */
  timeout() {
    if (this.phase !== 'question') return;
    this._endQuestion();
  }

  _endQuestion() {
    this.phase = 'reveal';
    this.history.push({ index: this.index, winner: this.winner, answers: { ...this.answers } });
  }

  get bothLocked() { return this.locked.a && this.locked.b; }

  /**
   * Guest-side mirror: apply a result the host announced. The caller is
   * responsible for verifying the host's claim first (see main.js).
   */
  applyExternal(winner, answers) {
    if (this.phase !== 'question') return;
    this.answers = { a: answers.a ?? null, b: answers.b ?? null };
    this.locked = { a: true, b: true };
    this.winner = winner;
    if (winner === 'a' || winner === 'b') this.scores[winner] += 1;
    this._endQuestion();
  }

  /** Whether the match would end if we advanced now (used by the guest mirror). */
  get finishedAfterCurrent() { return this._isFinished(this.index + 1); }

  get result() {
    if (this.scores.a > this.scores.b) return 'a';
    if (this.scores.b > this.scores.a) return 'b';
    return null;
  }
}

/**
 * A simple CPU opponent. Decides, per question, whether it will answer
 * correctly and after how many milliseconds.
 */
export function cpuPlan(R, difficulty, question, timeLimitMs) {
  const table = {
    easy: { accuracy: 0.55, minFrac: 0.45, maxFrac: 0.95 },
    normal: { accuracy: 0.75, minFrac: 0.3, maxFrac: 0.8 },
    hard: { accuracy: 0.92, minFrac: 0.15, maxFrac: 0.55 },
  };
  const d = table[difficulty] ?? table.normal;
  const correct = R.chance(d.accuracy);
  const delay = Math.floor(timeLimitMs * (d.minFrac + R.next() * (d.maxFrac - d.minFrac)));
  let value;
  if (question.kind === 'choice') {
    if (correct) value = String(question.answer);
    else value = String((question.answer + R.int(1, 3)) % question.choices.length);
  } else {
    value = correct ? String(question.answer) : String(question.answer + R.nonZeroInt(-3, 3));
  }
  return { correct, delay, value };
}
