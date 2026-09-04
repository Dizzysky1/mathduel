// UI controller. All peer-supplied strings reach the DOM through textContent only.
import { Match, cpuPlan, MAX_SUDDEN_DEATH } from './match.js';
import { checkAnswer, formatAnswer } from './questions.js';
import { mulberry32, makeRandom, hashSeed } from './rng.js';
import { NetSession } from './net.js';
import {
  PROTOCOL_VERSION, GRADE_OPTIONS, sanitizeName, normalizeRoomCode,
  randomNonceHex, sha256Hex,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const REVEAL_MS = 2600;
const REPO_URL = 'https://github.com/Dizzysky1/mathduel';

// ---------- screens ----------
const screens = ['home', 'lobby', 'handoff', 'game', 'over'];
function show(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle('active', s === name);
  window.scrollTo({ top: 0 });
}

// ---------- settings ----------
function readSettings() {
  const grade = $('grade').value;
  const rounds = Number($('rounds').value);
  const timeLimit = Number($('timeLimit').value);
  return {
    name: sanitizeName($('name').value),
    grade: GRADE_OPTIONS.includes(grade) ? grade : '10',
    rounds: [5, 10, 15, 20].includes(rounds) ? rounds : 10,
    timeLimit: [10, 15, 20, 30, 45].includes(timeLimit) ? timeLimit : 20,
    cpu: ['easy', 'normal', 'hard'].includes($('cpu').value) ? $('cpu').value : 'normal',
  };
}
function persistName() {
  try { localStorage.setItem('mathduel.name', sanitizeName($('name').value)); } catch { /* private mode */ }
}
function restoreName() {
  try {
    const v = localStorage.getItem('mathduel.name');
    if (v) $('name').value = sanitizeName(v);
  } catch { /* ignore */ }
}

function showHomeError(msg) {
  const el = $('home-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------- timer ----------
// The deadline is a setTimeout (fires even in throttled background tabs);
// requestAnimationFrame only drives the progress bar.
let timerRaf = null;
let timerDeadline = null;
let timerEnd = 0;
let timerTotal = 0;
function startTimer(seconds, onExpire) {
  stopTimer();
  timerTotal = seconds * 1000;
  timerEnd = performance.now() + timerTotal;
  const bar = $('timer-bar');
  const txt = $('timer-text');
  bar.classList.remove('low');
  const paint = () => {
    const left = Math.max(0, timerEnd - performance.now());
    bar.style.width = `${(left / timerTotal) * 100}%`;
    txt.textContent = Math.ceil(left / 1000);
    bar.classList.toggle('low', left < timerTotal * 0.25);
    if (left > 0) timerRaf = requestAnimationFrame(paint);
  };
  paint();
  timerDeadline = setTimeout(() => { stopTimer(); paint(); onExpire?.(); }, timerTotal);
}
function stopTimer() {
  if (timerRaf) cancelAnimationFrame(timerRaf);
  if (timerDeadline) clearTimeout(timerDeadline);
  timerRaf = null;
  timerDeadline = null;
}

// ---------- question rendering ----------
let submitHandler = null; // (value: string) => void
let inputEnabled = false;

function renderQuestion(q, { index, rounds, suddenDeath }) {
  $('round-label').textContent = suddenDeath ? `Sudden death ${index - rounds + 1}` : `Q ${index + 1} / ${rounds}`;
  $('q-topic').textContent = `Grade ${q.grade} · ${q.topic.replace(/-/g, ' ')}`;
  $('q-prompt').textContent = q.prompt;
  setFeedback('');
  const form = $('answer-form');
  const choices = $('choices');
  choices.replaceChildren();
  if (q.kind === 'choice') {
    form.hidden = true;
    choices.hidden = false;
    q.choices.forEach((text, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.dataset.index = String(i);
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);
      b.append(key, document.createTextNode(text));
      b.addEventListener('click', () => submitLocal(String(i)));
      choices.append(b);
    });
  } else {
    form.hidden = false;
    choices.hidden = true;
    $('answer').value = '';
    $('answer').focus({ preventScroll: true });
  }
  setInputEnabled(true);
}

function setInputEnabled(on) {
  inputEnabled = on;
  $('answer').disabled = !on;
  $('btn-submit').disabled = !on;
  for (const b of $('choices').querySelectorAll('button')) b.disabled = !on;
}

function setFeedback(text, cls = '') {
  const el = $('feedback');
  el.textContent = text;
  el.className = `feedback ${cls}`.trim();
}

function submitLocal(value) {
  if (!inputEnabled || !submitHandler) return;
  const v = String(value ?? '').trim().slice(0, 32);
  if (!v) return;
  submitHandler(v);
}

function markChoices(q, { correctIndex, chosen }) {
  for (const b of $('choices').querySelectorAll('button')) {
    const i = Number(b.dataset.index);
    if (i === correctIndex) b.classList.add('correct');
    else if (chosen !== null && i === chosen) b.classList.add('wrong');
  }
}

function updateScores(a, b, bumped) {
  $('score-a').textContent = String(a);
  $('score-b').textContent = String(b);
  if (bumped) {
    const el = $(`score-${bumped}`);
    el.classList.remove('bump');
    void el.offsetWidth; // restart animation
    el.classList.add('bump');
  }
}

function revealText(match, mySide, names) {
  const q = match.current;
  const ans = formatAnswer(q);
  if (match.winner === mySide) return { text: `Correct! +1  (answer: ${ans})`, cls: 'good' };
  if (match.winner) return { text: `${names[match.winner]} got it first. Answer: ${ans}`, cls: 'bad' };
  return { text: `Nobody scored. Answer: ${ans}`, cls: 'warn' };
}

// ---------- controllers ----------
let active = null; // current controller with quit()

function endMatch({ title, scoreText, detail, rematchable }) {
  stopTimer();
  $('over-title').textContent = title;
  $('over-score').textContent = scoreText;
  $('over-detail').textContent = detail || '';
  $('btn-rematch').hidden = !rematchable;
  $('btn-rematch').disabled = false;
  $('btn-rematch').textContent = 'Rematch';
  show('over');
}

function outcomeTitle(match, mySide, names) {
  const r = match.result;
  if (r === null) return 'Draw';
  return r === mySide ? 'You win! 🎉' : `${names[r]} wins`;
}

/** Shared per-question loop for locally-authoritative modes (CPU). */
class CpuGame {
  constructor(settings) {
    this.settings = settings;
    this.names = { a: settings.name, b: `CPU (${settings.cpu})` };
    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    this.seed = seedBytes[0];
    this.match = new Match({ seed: this.seed, grade: settings.grade, rounds: settings.rounds, timeLimit: settings.timeLimit });
    this.cpuR = makeRandom(mulberry32(this.seed ^ 0x9e3779b9));
    this.cpuTimer = null;
    this.nextTimer = null;
  }

  start() {
    $('score-a-name').textContent = this.names.a;
    $('score-b-name').textContent = this.names.b;
    updateScores(0, 0);
    show('game');
    submitHandler = (v) => this.onSubmit('a', v);
    this.advance();
  }

  advance() {
    if (!this.match.next()) return this.finish();
    const m = this.match;
    renderQuestion(m.current, { index: m.index, rounds: m.rounds, suddenDeath: m.isSuddenDeath });
    startTimer(m.timeLimit, () => { m.timeout(); this.reveal(); });
    const plan = cpuPlan(this.cpuR, this.settings.cpu, m.current, m.timeLimit * 1000);
    this.cpuTimer = setTimeout(() => this.onSubmit('b', plan.value), plan.delay);
  }

  onSubmit(who, value) {
    const m = this.match;
    const res = m.submit(who, value);
    if (!res.accepted) return;
    if (who === 'a') {
      if (res.won) { /* reveal below */ } else if (!res.correct) {
        setFeedback('Wrong, locked out for this question.', 'bad');
        setInputEnabled(false);
        if (m.current.kind === 'choice') markChoices(m.current, { correctIndex: null, chosen: Number(value) });
      }
    }
    if (m.phase === 'reveal') this.reveal();
  }

  reveal() {
    const m = this.match;
    stopTimer();
    clearTimeout(this.cpuTimer);
    setInputEnabled(false);
    const fb = revealText(m, 'a', this.names);
    setFeedback(fb.text, fb.cls);
    if (m.current.kind === 'choice') {
      markChoices(m.current, { correctIndex: m.current.answer, chosen: m.answers.a !== null ? Number(m.answers.a) : null });
    }
    updateScores(m.scores.a, m.scores.b, m.winner);
    this.nextTimer = setTimeout(() => this.advance(), REVEAL_MS);
  }

  finish() {
    const m = this.match;
    endMatch({
      title: outcomeTitle(m, 'a', this.names),
      scoreText: `${m.scores.a} – ${m.scores.b}`,
      detail: `${this.names.a} vs ${this.names.b} · Grade ${this.settings.grade}`,
      rematchable: true,
    });
  }

  rematch() { active = new CpuGame(this.settings); active.start(); }

  quit() { stopTimer(); clearTimeout(this.cpuTimer); clearTimeout(this.nextTimer); }
}

/** Pass & play: players alternate; each gets their own question stream. */
class LocalGame {
  constructor(settings) {
    this.settings = settings;
    this.names = { a: 'Player 1', b: 'Player 2' };
    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    // Two independent question lists so Player 2 never sees Player 1's answer.
    this.matches = {
      a: new Match({ seed: seedBytes[0], grade: settings.grade, rounds: settings.rounds, timeLimit: settings.timeLimit }),
      b: new Match({ seed: seedBytes[0] ^ 0x5bd1e995, grade: settings.grade, rounds: settings.rounds, timeLimit: settings.timeLimit }),
    };
    this.turn = 'a';
    this.round = 0;
    this.scores = { a: 0, b: 0 };
    this.nextTimer = null;
  }

  start() {
    $('score-a-name').textContent = this.names.a;
    $('score-b-name').textContent = this.names.b;
    updateScores(0, 0);
    submitHandler = (v) => this.onSubmit(v);
    this.handoff();
  }

  handoff() {
    if (this.round >= this.settings.rounds) return this.finish();
    $('handoff-title').textContent = `${this.names[this.turn]}, get ready`;
    show('handoff');
    $('btn-handoff').onclick = () => this.ask();
    $('btn-handoff').focus();
  }

  ask() {
    const m = this.matches[this.turn];
    m.next();
    show('game');
    renderQuestion(m.current, { index: this.round, rounds: this.settings.rounds, suddenDeath: false });
    $('round-label').textContent = `${this.names[this.turn]} · Q ${this.round + 1} / ${this.settings.rounds}`;
    startTimer(m.timeLimit, () => { m.timeout(); this.reveal(false); });
  }

  onSubmit(value) {
    const m = this.matches[this.turn];
    const res = m.submit(this.turn, value);
    if (!res.accepted) return;
    if (res.correct) this.scores[this.turn] += 1;
    this.reveal(res.correct, value);
  }

  reveal(correct, value = null) {
    stopTimer();
    setInputEnabled(false);
    const m = this.matches[this.turn];
    const ans = formatAnswer(m.current);
    setFeedback(correct ? `Correct! +1  (answer: ${ans})` : `Answer: ${ans}`, correct ? 'good' : 'bad');
    if (m.current.kind === 'choice') {
      markChoices(m.current, { correctIndex: m.current.answer, chosen: value !== null ? Number(value) : null });
    }
    updateScores(this.scores.a, this.scores.b, correct ? this.turn : null);
    this.nextTimer = setTimeout(() => {
      if (this.turn === 'a') this.turn = 'b';
      else { this.turn = 'a'; this.round += 1; }
      this.handoff();
    }, REVEAL_MS);
  }

  finish() {
    const { a, b } = this.scores;
    endMatch({
      title: a === b ? 'Draw' : `${this.names[a > b ? 'a' : 'b']} wins!`,
      scoreText: `${a} – ${b}`,
      detail: `Pass & play · Grade ${this.settings.grade}`,
      rematchable: true,
    });
  }

  rematch() { active = new LocalGame(this.settings); active.start(); }

  quit() { stopTimer(); clearTimeout(this.nextTimer); }
}

/** Online: shared handshake pieces. Host is side 'a', guest is side 'b'. */
class OnlineGame {
  constructor(settings, net) {
    this.settings = settings;
    this.net = net;
    this.role = net.role;
    this.mySide = this.role === 'host' ? 'a' : 'b';
    this.theirSide = this.role === 'host' ? 'b' : 'a';
    this.names = { a: this.role === 'host' ? settings.name : 'Opponent', b: this.role === 'guest' ? settings.name : 'Opponent' };
    this.match = null;
    this.hostNonce = null;
    this.hostCommit = null;
    this.guestNonce = null;
    this.rematch = { me: false, them: false };
    this.nextTimer = null;
    this.over = false;
    net.on('message', (m) => this.onMessage(m).catch((e) => this.abort(`Protocol error: ${e.message}`)));
    net.on('close', () => this.onDisconnect());
    net.on('error', (e) => { if (!this.over) this.abort(e.message); });
  }

  async beginHandshake() {
    // Host commits to its nonce before seeing the guest's, so neither side
    // can steer the question seed.
    this.hostNonce = randomNonceHex();
    this.hostCommit = await sha256Hex(this.hostNonce);
    this.net.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.settings.name, commit: this.hostCommit });
  }

  async onMessage(m) {
    const isHost = this.role === 'host';
    switch (m.t) {
      case 'hello': {
        if (isHost) return;
        this.names.a = m.name;
        this.hostCommit = m.commit;
        this.guestNonce = randomNonceHex();
        this.net.send({ t: 'hello_ack', v: PROTOCOL_VERSION, name: this.settings.name, nonce: this.guestNonce });
        $('lobby-status').textContent = `Connected to ${m.name}. Waiting for host to start…`;
        return;
      }
      case 'hello_ack': {
        if (!isHost || !this.hostNonce || this.match) return;
        this.names.b = m.name;
        this.guestNonce = m.nonce;
        const seed = hashSeed(this.hostNonce + this.guestNonce);
        this.match = new Match({ seed, grade: this.settings.grade, rounds: this.settings.rounds, timeLimit: this.settings.timeLimit });
        this.net.send({ t: 'start', nonce: this.hostNonce, grade: this.settings.grade, rounds: this.settings.rounds, timeLimit: this.settings.timeLimit });
        this.enterGame();
        this.nextTimer = setTimeout(() => this.hostAdvance(), 1200);
        return;
      }
      case 'start': {
        if (isHost || !this.hostCommit || !this.guestNonce || this.match) return;
        const commit = await sha256Hex(m.nonce);
        if (commit !== this.hostCommit) return this.abort('Seed verification failed. The host may be running a modified client.');
        const seed = hashSeed(m.nonce + this.guestNonce);
        this.settings = { ...this.settings, grade: m.grade, rounds: m.rounds, timeLimit: m.timeLimit };
        this.match = new Match({ seed, grade: m.grade, rounds: m.rounds, timeLimit: m.timeLimit });
        this.enterGame();
        return;
      }
      case 'next': {
        if (isHost || !this.match) return;
        if (m.q !== this.match.index + 1) return this.abort('Out-of-order question from host.');
        if (!this.match.next()) return this.abort('Host advanced past the end of the match.');
        this.showQuestion();
        return;
      }
      case 'answer': {
        if (!isHost || !this.match || this.match.phase !== 'question' || m.q !== this.match.index) return;
        const res = this.match.submit('b', m.value);
        if (res.accepted && this.match.phase === 'reveal') this.hostReveal();
        return;
      }
      case 'result': {
        if (isHost || !this.match || this.match.phase !== 'question' || m.q !== this.match.index) return;
        const q = this.match.current;
        const winner = m.winner === 'host' ? 'a' : m.winner === 'guest' ? 'b' : null;
        // Verify the host's claim against our own copy of the question.
        if (winner === 'a' && !checkAnswer(q, m.hostAns)) return this.abort('Host claimed a point with a wrong answer. Match voided.');
        if (winner === 'b' && !checkAnswer(q, m.guestAns)) return this.abort('Host reported an inconsistent result. Match voided.');
        this.match.applyExternal(winner, { a: m.hostAns, b: m.guestAns });
        this.revealUI();
        return;
      }
      case 'gameover': {
        if (isHost || !this.match) return;
        if (m.host !== this.match.scores.a || m.guest !== this.match.scores.b) return this.abort('Final score mismatch. Match voided.');
        this.finish();
        return;
      }
      case 'rematch': {
        this.rematch.them = true;
        $('over-detail').textContent = `${this.names[this.theirSide]} wants a rematch.`;
        this.maybeRematch();
        return;
      }
      default:
        return;
    }
  }

  enterGame() {
    $('score-a-name').textContent = this.names.a;
    $('score-b-name').textContent = this.names.b;
    updateScores(0, 0);
    $('q-prompt').textContent = 'Get ready…';
    $('q-topic').textContent = '';
    $('answer-form').hidden = true;
    $('choices').hidden = true;
    setFeedback('');
    show('game');
    submitHandler = (v) => this.onLocalSubmit(v);
  }

  showQuestion() {
    const m = this.match;
    renderQuestion(m.current, { index: m.index, rounds: m.rounds, suddenDeath: m.isSuddenDeath });
    startTimer(m.timeLimit, () => {
      if (this.role === 'host') { m.timeout(); this.hostReveal(); } else { setInputEnabled(false); }
    });
  }

  hostAdvance() {
    const m = this.match;
    if (!m.next()) {
      this.net.send({ t: 'gameover', host: m.scores.a, guest: m.scores.b });
      return this.finish();
    }
    this.net.send({ t: 'next', q: m.index });
    this.showQuestion();
  }

  onLocalSubmit(value) {
    const m = this.match;
    if (!m || m.phase !== 'question') return;
    if (this.role === 'host') {
      const res = m.submit('a', value);
      if (!res.accepted) return;
      if (!res.correct) {
        setFeedback('Wrong, locked out for this question.', 'bad');
        setInputEnabled(false);
        if (m.current.kind === 'choice') markChoices(m.current, { correctIndex: null, chosen: Number(value) });
      }
      if (m.phase === 'reveal') this.hostReveal();
    } else {
      // Guest: instant local feedback, host confirms ordering.
      if (m.locked.b) return;
      const correct = checkAnswer(m.current, value);
      m.locked.b = true;
      m.answers.b = value;
      setInputEnabled(false);
      if (correct) setFeedback('Correct, confirming with host…', 'good');
      else {
        setFeedback('Wrong, locked out for this question.', 'bad');
        if (m.current.kind === 'choice') markChoices(m.current, { correctIndex: null, chosen: Number(value) });
      }
      this.net.send({ t: 'answer', q: m.index, value });
    }
  }

  hostReveal() {
    const m = this.match;
    this.net.send({
      t: 'result', q: m.index,
      winner: m.winner === 'a' ? 'host' : m.winner === 'b' ? 'guest' : null,
      hostAns: m.answers.a, guestAns: m.answers.b,
    });
    this.revealUI();
    this.nextTimer = setTimeout(() => this.hostAdvance(), REVEAL_MS);
  }

  revealUI() {
    const m = this.match;
    stopTimer();
    setInputEnabled(false);
    const fb = revealText(m, this.mySide, this.names);
    setFeedback(fb.text, fb.cls);
    if (m.current.kind === 'choice') {
      const mine = m.answers[this.mySide];
      markChoices(m.current, { correctIndex: m.current.answer, chosen: mine !== null ? Number(mine) : null });
    }
    updateScores(m.scores.a, m.scores.b, m.winner);
  }

  finish() {
    this.over = true;
    const m = this.match;
    endMatch({
      title: outcomeTitle(m, this.mySide, this.names),
      scoreText: `${m.scores.a} – ${m.scores.b}`,
      detail: `${this.names.a} vs ${this.names.b} · Grade ${this.settings.grade}`,
      rematchable: true,
    });
  }

  requestRematch() {
    if (this.rematch.me) return;
    this.rematch.me = true;
    this.net.send({ t: 'rematch' });
    $('btn-rematch').disabled = true;
    $('btn-rematch').textContent = 'Waiting for opponent…';
    this.maybeRematch();
  }

  maybeRematch() {
    if (!(this.rematch.me && this.rematch.them)) return;
    this.rematch = { me: false, them: false };
    this.match = null;
    this.over = false;
    this.hostCommit = null;
    this.guestNonce = null;
    $('lobby-title').textContent = 'Rematch';
    $('lobby-code').textContent = '';
    $('lobby-status').textContent = 'Starting…';
    show('lobby');
    if (this.role === 'host') this.beginHandshake();
  }

  onDisconnect() {
    if (this.over) {
      $('over-detail').textContent = 'Opponent left.';
      $('btn-rematch').hidden = true;
      return;
    }
    this.abort('Opponent disconnected.');
  }

  abort(reason) {
    if (this.over) return;
    this.over = true;
    stopTimer();
    clearTimeout(this.nextTimer);
    const m = this.match;
    this.net.close();
    endMatch({
      title: 'Match ended',
      scoreText: m ? `${m.scores.a} – ${m.scores.b}` : '',
      detail: reason,
      rematchable: false,
    });
  }

  quit() { stopTimer(); clearTimeout(this.nextTimer); this.over = true; this.net.close(); }
}

// ---------- wiring ----------
function goHome() {
  active?.quit();
  active = null;
  submitHandler = null;
  showHomeError('');
  show('home');
}

async function hostOnline() {
  const settings = readSettings();
  persistName();
  showHomeError('');
  $('btn-host').disabled = true;
  const net = new NetSession();
  try {
    const code = await net.host();
    $('lobby-title').textContent = 'Room ready';
    $('lobby-hint').textContent = 'Share this code with your opponent.';
    $('lobby-code').textContent = code;
    $('btn-copy').hidden = false;
    $('lobby-status').textContent = 'Waiting for an opponent…';
    show('lobby');
    active = new OnlineGame(settings, net);
    net.on('open', () => {
      $('lobby-status').textContent = 'Opponent connected. Starting…';
      active.beginHandshake().catch((e) => active.abort(e.message));
    });
  } catch (e) {
    net.close();
    showHomeError(e.message);
  } finally {
    $('btn-host').disabled = false;
  }
}

async function joinOnline() {
  const code = normalizeRoomCode($('join-code').value);
  if (!code) return showHomeError('Enter the 6-character room code.');
  const settings = readSettings();
  persistName();
  showHomeError('');
  $('btn-join').disabled = true;
  $('lobby-title').textContent = 'Joining…';
  $('lobby-hint').textContent = '';
  $('lobby-code').textContent = code;
  $('btn-copy').hidden = true;
  $('lobby-status').textContent = 'Connecting to host…';
  show('lobby');
  const net = new NetSession();
  try {
    await net.join(code);
    active = new OnlineGame(settings, net);
    $('lobby-status').textContent = 'Connected. Waiting for host…';
  } catch (e) {
    net.close();
    show('home');
    showHomeError(e.message);
  } finally {
    $('btn-join').disabled = false;
  }
}

function init() {
  restoreName();
  $('repo-link').href = REPO_URL;
  $('btn-host').addEventListener('click', hostOnline);
  $('btn-join').addEventListener('click', joinOnline);
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinOnline(); } });
  $('home-form').addEventListener('submit', (e) => e.preventDefault());
  $('btn-cpu').addEventListener('click', () => { persistName(); active = new CpuGame(readSettings()); active.start(); });
  $('btn-local').addEventListener('click', () => { persistName(); active = new LocalGame(readSettings()); active.start(); });
  $('btn-lobby-cancel').addEventListener('click', goHome);
  $('btn-quit').addEventListener('click', goHome);
  $('btn-home').addEventListener('click', goHome);
  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('lobby-code').textContent); $('btn-copy').textContent = 'Copied!'; }
    catch { $('btn-copy').textContent = 'Select and copy'; }
    setTimeout(() => { $('btn-copy').textContent = 'Copy code'; }, 1500);
  });
  $('btn-rematch').addEventListener('click', () => {
    if (!active) return;
    if (active instanceof OnlineGame) active.requestRematch();
    else active.rematch();
  });
  $('answer-form').addEventListener('submit', (e) => { e.preventDefault(); submitLocal($('answer').value); });
  document.addEventListener('keydown', (e) => {
    if (!$('screen-game').classList.contains('active')) return;
    if (e.target instanceof HTMLInputElement) return;
    if (['1', '2', '3', '4'].includes(e.key) && !$('choices').hidden) submitLocal(String(Number(e.key) - 1));
  });
  window.addEventListener('beforeunload', () => active?.quit?.());
}

init();
