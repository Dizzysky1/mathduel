// Procedural question generator for MathDuel (grades 8-12).
// Everything here is pure and deterministic given the R object from rng.js's
// makeRandom(next) — never call Math.random directly.

export const GRADES = [8, 9, 10, 11, 12];

const TRIPLES = [
  [3, 4, 5],
  [6, 8, 10],
  [5, 12, 13],
  [9, 12, 15],
  [8, 15, 17],
  [7, 24, 25],
  [20, 21, 29],
  [12, 16, 20],
  [9, 40, 41],
  [10, 24, 26],
];

// ---------------------------------------------------------------------------
// Small formatting/math helpers
// ---------------------------------------------------------------------------

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

// "+ 5" or "− 5" (never a bare negative sign floating in the middle of a prompt)
function term(n) {
  return n >= 0 ? `+ ${n}` : `− ${Math.abs(n)}`;
}

// signed leading number, e.g. sn(-3) -> "−3", sn(3) -> "3"
function sn(n) {
  return n < 0 ? `−${Math.abs(n)}` : `${n}`;
}

// Leading coefficient-of-x term (start of an expression), e.g. leadX(3) -> "3x",
// leadX(-1) -> "−x", leadX(1, '²') -> "x²" — never shows a bare "1" coefficient.
function leadX(n, powerSup = '') {
  if (n === 1) return `x${powerSup}`;
  if (n === -1) return `−x${powerSup}`;
  return `${sn(n)}x${powerSup}`;
}

// Mid-expression coefficient-of-x term (preceded by "+"/"−"), e.g. midX(5) -> "+ 5x",
// midX(-1) -> "− x", midX(1) -> "+ x".
function midX(n, powerSup = '') {
  if (n === 1) return `+ x${powerSup}`;
  if (n === -1) return `− x${powerSup}`;
  return `${term(n)}x${powerSup}`;
}

const SUP_MAP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻' };
function sup(n) {
  return String(n).split('').map((c) => SUP_MAP[c] ?? c).join('');
}
// Exponent suffix for a variable term: hides the exponent entirely when it's 1
// (x¹ should just render as x).
function powSup(n) {
  return n === 1 ? '' : sup(n);
}

const SUB_MAP = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
function sub(n) {
  return String(n).split('').map((c) => SUB_MAP[c] ?? c).join('');
}

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function nPr(n, r) {
  let v = 1;
  for (let i = 0; i < r; i++) v *= n - i;
  return v;
}

function nCr(n, r) {
  return Math.round(nPr(n, r) / factorial(r));
}

// x^n for integer bases/exponents (used only where exact integer result matters)
function ipow(base, exp) {
  return Math.pow(base, exp);
}

// Runs `fn` up to `maxTries` times until it returns a non-null value.
// Falls back to `fallback()` if every attempt fails — this guarantees no
// generator can ever infinite-loop.
function retry(fn, fallback, maxTries = 100) {
  for (let i = 0; i < maxTries; i++) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
  }
  return fallback();
}

// Builds a 4-choice question payload: shuffles [correct, ...distractors] and
// returns { choices, answer }. Distractors are de-duplicated against each
// other and against the correct text.
function buildChoices(R, correctText, distractorTexts) {
  const seen = new Set([correctText]);
  const uniqueDistractors = [];
  for (const d of distractorTexts) {
    if (!seen.has(d)) {
      seen.add(d);
      uniqueDistractors.push(d);
    }
    if (uniqueDistractors.length === 3) break;
  }
  // Pad with harmless filler if somehow we don't have 3 unique distractors.
  let pad = 1;
  while (uniqueDistractors.length < 3) {
    const filler = `${correctText} `.repeat(1) + `(${pad})`;
    if (!seen.has(filler)) {
      seen.add(filler);
      uniqueDistractors.push(filler);
    }
    pad++;
  }
  const items = R.shuffle([
    { text: correctText, correct: true },
    ...uniqueDistractors.map((text) => ({ text, correct: false })),
  ]);
  const answer = items.findIndex((it) => it.correct);
  return { choices: items.map((it) => it.text), answer };
}

// Simplifies a radical sqrt(n) into { coeff, radicand } such that
// coeff * sqrt(radicand) === sqrt(n) and radicand is square-free.
function simplifyRadical(n) {
  let coeff = 1;
  let radicand = n;
  for (let f = 2; f * f <= radicand; f++) {
    while (radicand % (f * f) === 0) {
      radicand /= f * f;
      coeff *= f;
    }
  }
  return { coeff, radicand };
}

// Fraction reduction helper for degree<->radian conversions, probabilities, etc.
function reduceFraction(num, den) {
  if (den < 0) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

function radianLabel(deg) {
  // deg/180 * pi, reduced
  const { num, den } = reduceFraction(deg, 180);
  if (num === 0) return '0';
  const numStr = num === 1 ? '' : num === -1 ? '−' : `${num}`;
  const piStr = `${numStr}π`;
  return den === 1 ? piStr : `${piStr}/${den}`;
}

// ---------------------------------------------------------------------------
// Numeric answer "niceness" helpers used by generators
// ---------------------------------------------------------------------------

function isNiceAnswer(x) {
  if (!Number.isFinite(x)) return false;
  if (Math.abs(x * 100 - Math.round(x * 100)) < 1e-6) return true;
  for (let k = 1; k <= 12; k++) {
    if (Math.abs(x * k - Math.round(x * k)) < 1e-6) return true;
  }
  return false;
}

function numQ(fields) {
  return { kind: 'numeric', tolerance: 1e-6, ...fields };
}

function choiceQ(fields) {
  return { kind: 'choice', ...fields };
}

// ===========================================================================
// GRADE 8
// ===========================================================================

function g8_intArith(R) {
  const a = R.nonZeroInt(-9, 9);
  const b = R.int(-9, 9);
  const c = R.int(-9, 9);
  const d = R.int(-9, 9);
  const answer = a * (b - c) + d;
  const prompt = `Evaluate: ${sn(a)} × (${sn(b)} ${term(-c)}) ${term(d)}`;
  return numQ({ prompt, answer });
}

function g8_linearEq(R) {
  const x = R.nonZeroInt(-12, 12);
  const a = R.nonZeroInt(-9, 9);
  const b = R.int(-20, 20);
  const c = a * x + b;
  const prompt = `Solve for x: ${leadX(a)} ${term(b)} = ${sn(c)}`;
  return numQ({ prompt, answer: x });
}

function g8_percent(R) {
  if (R.chance(0.5)) {
    const p = R.pick([5, 10, 15, 20, 25, 40, 50, 60, 75, 80]);
    const n = R.int(1, 25) * 20;
    const answer = (p * n) / 100;
    return numQ({ prompt: `What is ${p}% of ${n}?`, answer });
  }
  const p = R.pick([5, 10, 15, 20, 25, 50]);
  const n = R.int(1, 25) * 20;
  const up = R.chance(0.5);
  const answer = up ? n * (1 + p / 100) : n * (1 - p / 100);
  const verb = up ? 'increases' : 'decreases';
  return numQ({ prompt: `A price of $${n} ${verb} by ${p}%. What is the new price?`, answer });
}

function g8_ratio(R) {
  const b = R.int(2, 12);
  const d = R.int(2, 12);
  const m = R.int(2, 9);
  const a = b * m;
  const x = d * m;
  return numQ({ prompt: `Solve for x: ${a}/${b} = x/${d}`, answer: x });
}

function g8_exponent(R) {
  const base = R.pick([-6, -5, -4, -3, -2, 2, 3, 4, 5, 6]);
  const exp = R.int(2, 4);
  const answer = ipow(base, exp);
  return numQ({ prompt: `Evaluate: (${sn(base)})${sup(exp)}`, answer });
}

function g8_sqrt(R) {
  const r = R.int(2, 20);
  return numQ({ prompt: `√${r * r} = ?`, answer: r });
}

function g8_pythagorean(R) {
  const [a0, b0, c0] = R.pick(TRIPLES);
  const scale = R.int(1, 3);
  const a = a0 * scale;
  const b = b0 * scale;
  const c = c0 * scale;
  if (R.chance(0.5)) {
    return numQ({ prompt: `A right triangle has legs ${a} and ${b}. Find the hypotenuse.`, answer: c });
  }
  const askLeg = R.chance(0.5) ? a : b;
  const otherLeg = askLeg === a ? b : a;
  return numQ({ prompt: `A right triangle has hypotenuse ${c} and one leg ${otherLeg}. Find the other leg.`, answer: askLeg });
}

function g8_slope(R) {
  const x1 = R.int(-10, 10);
  const y1 = R.int(-10, 10);
  const dx = R.nonZeroInt(1, 9) * R.pick([1, -1]);
  const dy = R.nonZeroInt(-9, 9);
  const x2 = x1 + dx;
  const y2 = y1 + dy;
  return numQ({ prompt: `Find the slope of the line through (${x1}, ${y1}) and (${x2}, ${y2}).`, answer: dy / dx });
}

function g8_evalExpression(R) {
  const a = R.nonZeroInt(-6, 6);
  const b = R.int(-9, 9);
  const c = R.int(-9, 9);
  const x0 = R.int(-5, 5);
  const answer = a * x0 * x0 + b * x0 + c;
  return numQ({ prompt: `Evaluate ${leadX(a, '²')} ${midX(b)} ${term(c)} at x = ${sn(x0)}`, answer });
}

function g8_simpleInterest(R) {
  const P = R.int(1, 20) * 100;
  const r = R.pick([2, 3, 4, 5, 6, 8, 10]);
  const t = R.int(1, 5);
  const answer = (P * r * t) / 100;
  return numQ({ prompt: `Find the simple interest on $${P} at ${r}% annual rate for ${t} year${t === 1 ? '' : 's'}.`, answer });
}

const GRADE8_TOPICS = [
  { topic: 'int-arith', gen: g8_intArith },
  { topic: 'linear-eq', gen: g8_linearEq },
  { topic: 'percent', gen: g8_percent },
  { topic: 'ratio-proportion', gen: g8_ratio },
  { topic: 'exponent-eval', gen: g8_exponent },
  { topic: 'sqrt-perfect', gen: g8_sqrt },
  { topic: 'pythagorean', gen: g8_pythagorean },
  { topic: 'slope', gen: g8_slope },
  { topic: 'evaluate-expression', gen: g8_evalExpression },
  { topic: 'simple-interest', gen: g8_simpleInterest },
];

// ===========================================================================
// GRADE 9
// ===========================================================================

function g9_linearBothSides(R) {
  const x = R.nonZeroInt(-12, 12);
  let a = R.nonZeroInt(-8, 8);
  let c = R.nonZeroInt(-8, 8);
  if (a === c) c = c === 8 ? c - 1 : c + 1;
  const b = R.int(-20, 20);
  const d = b + (a - c) * x;
  const prompt = `Solve for x: ${leadX(a)} ${term(b)} = ${leadX(c)} ${term(d)}`;
  return numQ({ prompt, answer: x });
}

function g9_systems(R) {
  const build = () => {
    const x = R.int(-9, 9);
    const y = R.int(-9, 9);
    const a1 = R.nonZeroInt(-9, 9);
    const b1 = R.nonZeroInt(-9, 9);
    const a2 = R.nonZeroInt(-9, 9);
    const b2 = R.nonZeroInt(-9, 9);
    if (a1 * b2 - a2 * b1 === 0) return null;
    const e1 = a1 * x + b1 * y;
    const e2 = a2 * x + b2 * y;
    return { a1, b1, e1, a2, b2, e2, x, y };
  };
  const { a1, b1, e1, a2, b2, e2, x, y } = retry(build, () => ({ a1: 1, b1: 1, e1: 3, a2: 1, b2: -1, e2: 1, x: 2, y: 1 }));
  const askX = R.chance(0.5);
  const line1 = `${leadX(a1)} ${b1 >= 0 ? '+' : '−'} ${Math.abs(b1)}y = ${sn(e1)}`;
  const line2 = `${leadX(a2)} ${b2 >= 0 ? '+' : '−'} ${Math.abs(b2)}y = ${sn(e2)}`;
  return numQ({
    prompt: `Solve the system for ${askX ? 'x' : 'y'}:\n${line1}\n${line2}`,
    answer: askX ? x : y,
  });
}

function g9_distributeSimplify(R) {
  const a = R.nonZeroInt(-6, 6);
  const b = R.nonZeroInt(-6, 6);
  const c = R.int(-9, 9);
  const d = R.int(-9, 9);
  const x0 = R.int(-5, 5);
  const answer = a * (b * x0 + c) + d;
  return numQ({
    prompt: `Simplify ${sn(a)}(${leadX(b)} ${term(c)}) ${term(d)}, then evaluate the result at x = ${sn(x0)}.`,
    answer,
  });
}

function g9_exponentRules(R) {
  const kind = R.pick(['product', 'power', 'quotient']);
  const x = 'x';
  if (kind === 'product') {
    const a = R.int(2, 8);
    const b = R.int(2, 8);
    const correct = `${x}${sup(a + b)}`;
    const distractors = [`${x}${sup(a * b)}`, `${x}${sup(Math.abs(a - b))}`, `${x}${sup(a + b + 1)}`];
    const { choices, answer } = buildChoices(R, correct, distractors);
    return choiceQ({ prompt: `Simplify: ${x}${sup(a)} · ${x}${sup(b)}`, choices, answer });
  }
  if (kind === 'power') {
    const a = R.int(2, 6);
    const b = R.int(2, 5);
    const correct = `${x}${sup(a * b)}`;
    const distractors = [`${x}${sup(a + b)}`, `${x}${sup(a ** 2 + b)}`, `${x}${sup(a * b + 1)}`];
    const { choices, answer } = buildChoices(R, correct, distractors);
    return choiceQ({ prompt: `Simplify: (${x}${sup(a)})${sup(b)}`, choices, answer });
  }
  const a = R.int(5, 12);
  const b = R.int(1, a - 1);
  const correct = `${x}${powSup(a - b)}`;
  const distractors = [`${x}${sup(a + b)}`, `${x}${sup(a * b)}`, `${x}${powSup(Math.max(1, a - b - 1))}`];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Simplify: ${x}${sup(a)} / ${x}${sup(b)}`, choices, answer });
}

// (x - r): the correct factor for a root r
function factorStr(r) {
  return r >= 0 ? `(x − ${r})` : `(x + ${Math.abs(r)})`;
}
// (x + r): the common sign-error distractor factor for a root r
function factorStrPlus(r) {
  return r >= 0 ? `(x + ${r})` : `(x − ${Math.abs(r)})`;
}

function g9_factoring(R) {
  const r1 = R.nonZeroInt(-9, 9);
  let r2 = R.nonZeroInt(-9, 9);
  const b = -(r1 + r2);
  const c = r1 * r2;
  const correct = `${factorStr(r1)}${factorStr(r2)}`;
  const distractors = [
    `${factorStrPlus(r1)}${factorStrPlus(r2)}`,
    `${factorStr(r1)}${factorStrPlus(r2)}`,
    `${factorStrPlus(r1)}${factorStr(r2)}`,
  ];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Factor: x² ${midX(b)} ${term(c)}`, choices, answer });
}

function g9_absoluteValue(R) {
  const a = R.nonZeroInt(-6, 6);
  const s1 = R.int(-10, 10);
  const d = R.nonZeroInt(1, 8);
  const s2 = s1 + 2 * d;
  const b = -a * (s1 + s2) / 2;
  const c = Math.abs(a * s1 + b);
  const larger = Math.max(s1, s2);
  const smaller = Math.min(s1, s2);
  const askLarger = R.chance(0.5);
  return numQ({
    prompt: `Solve for x: |${leadX(a)} ${term(b)}| = ${c}. Give the ${askLarger ? 'larger' : 'smaller'} solution.`,
    answer: askLarger ? larger : smaller,
  });
}

function g9_inequality(R) {
  const v = R.int(-10, 10);
  const a = R.nonZeroInt(-9, 9);
  const b = R.int(-15, 15);
  const c = a * v + b;
  // Fullwidth lookalikes for < and > — visually identical but not the literal
  // ASCII angle-bracket characters (kept out of prompts/choices for HTML safety).
  const symbolPairs = [
    ['＜', '＞'],
    ['＞', '＜'],
    ['≤', '≥'],
    ['≥', '≤'],
  ];
  const [sym, flipped] = R.pick(symbolPairs);
  const resultSym = a < 0 ? flipped : sym;
  const correct = `x ${resultSym} ${sn(v)}`;
  const distractors = [`x ${sym} ${sn(v)}`, `x ${resultSym} ${sn(v + 1)}`, `x ${sym} ${sn(v + 1)}`];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Solve: ${leadX(a)} ${term(b)} ${sym} ${sn(c)}`, choices, answer });
}

function g9_arithmeticSequence(R) {
  const a1 = R.int(-10, 10);
  const d = R.nonZeroInt(-9, 9);
  const n = R.int(5, 20);
  const answer = a1 + (n - 1) * d;
  return numQ({ prompt: `An arithmetic sequence has first term ${a1} and common difference ${d}. Find the ${n}th term.`, answer });
}

function g9_evalQuadraticFn(R) {
  const a = R.nonZeroInt(-5, 5);
  const b = R.int(-9, 9);
  const c = R.int(-9, 9);
  const x0 = R.int(-5, 5);
  const answer = a * x0 * x0 + b * x0 + c;
  return numQ({ prompt: `Let f(x) = ${leadX(a, '²')} ${midX(b)} ${term(c)}. Find f(${sn(x0)}).`, answer });
}

function g9_meanMedian(R) {
  const n = 5;
  if (R.chance(0.5)) {
    const vals = [];
    for (let i = 0; i < n; i++) vals.push(R.int(-15, 15));
    vals.sort((a, b) => a - b);
    const median = vals[Math.floor(n / 2)];
    return numQ({ prompt: `Find the median of: ${vals.join(', ')}`, answer: median });
  }
  const others = [];
  for (let i = 0; i < n - 1; i++) others.push(R.int(-15, 15));
  const targetMean = R.int(-10, 10);
  const last = targetMean * n - others.reduce((s, v) => s + v, 0);
  const vals = [...others, last];
  return numQ({ prompt: `Find the mean of: ${vals.join(', ')}`, answer: targetMean });
}

const GRADE9_TOPICS = [
  { topic: 'linear-both-sides', gen: g9_linearBothSides },
  { topic: 'systems-2x2', gen: g9_systems },
  { topic: 'distribute-simplify', gen: g9_distributeSimplify },
  { topic: 'exponent-rules', gen: g9_exponentRules },
  { topic: 'factoring-trinomial', gen: g9_factoring },
  { topic: 'absolute-value', gen: g9_absoluteValue },
  { topic: 'linear-inequality', gen: g9_inequality },
  { topic: 'arithmetic-sequence', gen: g9_arithmeticSequence },
  { topic: 'evaluate-function', gen: g9_evalQuadraticFn },
  { topic: 'mean-median', gen: g9_meanMedian },
];

// ===========================================================================
// GRADE 10
// ===========================================================================

function g10_quadraticFactor(R) {
  const r1 = R.int(-9, 9);
  const r2 = R.int(-9, 9);
  const b = -(r1 + r2);
  const c = r1 * r2;
  const mode = R.pick(['larger', 'smaller', 'sum', 'product']);
  let answer;
  if (mode === 'larger') answer = Math.max(r1, r2);
  else if (mode === 'smaller') answer = Math.min(r1, r2);
  else if (mode === 'sum') answer = r1 + r2;
  else answer = r1 * r2;
  const askText = mode === 'sum' ? 'the sum of the roots' : mode === 'product' ? 'the product of the roots' : `the ${mode} root`;
  return numQ({ prompt: `Solve: x² ${midX(b)} ${term(c)} = 0. Give ${askText}.`, answer });
}

function g10_compositeShape(R) {
  const W = R.int(6, 20);
  const H = R.int(6, 20);
  const w = R.int(1, Math.floor(W / 2));
  const h = R.int(1, Math.floor(H / 2));
  if (R.chance(0.5)) {
    const answer = W * H - w * h;
    return numQ({
      prompt: `A ${W}×${H} rectangle has a ${w}×${h} rectangular notch cut from one corner. Find the remaining area.`,
      answer,
    });
  }
  const answer = 2 * (W + H);
  return numQ({
    prompt: `A ${W}×${H} rectangle has a ${w}×${h} rectangular notch cut from one corner, forming an L-shape. Find the perimeter of the L-shape.`,
    answer,
  });
}

function g10_circle(R) {
  const r = R.int(1, 15);
  if (R.chance(0.5)) {
    return numQ({ prompt: `A circle has radius ${r}. Its area is kπ. Find k.`, answer: r * r });
  }
  return numQ({ prompt: `A circle has radius ${r}. Its circumference is kπ. Find k.`, answer: 2 * r });
}

function g10_volume(R) {
  const shape = R.pick(['cylinder', 'cone', 'sphere']);
  const r = R.int(1, 6);
  if (shape === 'cylinder') {
    const h = R.int(1, 10);
    return numQ({ prompt: `A cylinder has radius ${r} and height ${h}. Its volume is kπ. Find k.`, answer: r * r * h });
  }
  if (shape === 'cone') {
    const h = R.int(1, 10);
    return numQ({ prompt: `A cone has radius ${r} and height ${h}. Its volume is kπ. Find k.`, answer: (r * r * h) / 3 });
  }
  return numQ({ prompt: `A sphere has radius ${r}. Its volume is kπ. Find k.`, answer: (4 * r * r * r) / 3 });
}

function g10_distance(R) {
  const [a0, b0, c0] = R.pick(TRIPLES);
  const scale = R.int(1, 2);
  const dx = a0 * scale * R.pick([1, -1]);
  const dy = b0 * scale * R.pick([1, -1]);
  const x1 = R.int(-10, 10);
  const y1 = R.int(-10, 10);
  const x2 = x1 + dx;
  const y2 = y1 + dy;
  return numQ({ prompt: `Find the distance between (${x1}, ${y1}) and (${x2}, ${y2}).`, answer: c0 * scale });
}

function g10_midpoint(R) {
  const mx = R.int(-10, 10);
  const my = R.int(-10, 10);
  const dx = R.int(-10, 10);
  const dy = R.int(-10, 10);
  const x1 = mx - dx;
  const x2 = mx + dx;
  const y1 = my - dy;
  const y2 = my + dy;
  const askX = R.chance(0.5);
  return numQ({
    prompt: `Find the ${askX ? 'x' : 'y'}-coordinate of the midpoint of (${x1}, ${y1}) and (${x2}, ${y2}).`,
    answer: askX ? mx : my,
  });
}

function g10_similarTriangles(R) {
  const [a0, b0] = R.pick(TRIPLES);
  const k = R.int(2, 4);
  const AB = a0;
  const DE = a0 * k;
  const BC = b0;
  const answer = BC * k;
  return numQ({
    prompt: `Triangle ABC ~ Triangle DEF. AB = ${AB}, DE = ${DE}, BC = ${BC}. Find EF.`,
    answer,
  });
}

function g10_radicals(R) {
  const s = R.pick([2, 3, 5, 6, 7, 10, 11]);
  const m = R.int(2, 6);
  const n = m * m * s;
  const correct = `${m}√${s}`;
  const distractors = [`√${n}`, `${m}√${s * 2}`, `${m + 1}√${s}`];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Simplify: √${n}`, choices, answer });
}

function g10_vertex(R) {
  const h = R.int(-8, 8);
  const k = R.int(-10, 10);
  const b = -2 * h;
  const c = k + h * h;
  const correct = `(${sn(h)}, ${sn(k)})`;
  const distractors = [`(${sn(-h)}, ${sn(k)})`, `(${sn(h)}, ${sn(-k)})`, `(${sn(h)}, ${sn(c)})`];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Find the vertex of y = x² ${midX(b)} ${term(c)}`, choices, answer });
}

const REGULAR_NGONS = [3, 4, 5, 6, 8, 9, 10, 12, 15, 18, 20, 24, 36];

function g10_polygonAngles(R) {
  if (R.chance(0.5)) {
    const n = R.int(3, 20);
    return numQ({ prompt: `Find the sum of the interior angles of a convex ${n}-gon (in degrees).`, answer: (n - 2) * 180 });
  }
  const n = R.pick(REGULAR_NGONS);
  const answer = ((n - 2) * 180) / n;
  return numQ({ prompt: `Find the measure of each interior angle of a regular ${n}-gon (in degrees).`, answer });
}

function g10_probability(R) {
  const kind = R.pick(['die', 'spinner', 'dice-sum']);
  if (kind === 'die') {
    const events = [
      ['rolling an even number', 3, 6],
      ['rolling an odd number', 3, 6],
      ['rolling a number greater than 4', 2, 6],
      ['rolling a 1 or 2', 2, 6],
      ['rolling a number less than 3', 2, 6],
    ];
    const [desc, fav, total] = R.pick(events);
    return numQ({ prompt: `A fair 6-sided die is rolled. Find the probability of ${desc}.`, answer: fav / total });
  }
  if (kind === 'spinner') {
    const n = R.int(4, 12);
    const fav = R.int(1, n - 1);
    return numQ({ prompt: `A spinner has ${n} equal sections numbered 1 to ${n}. Find the probability of landing on a number from 1 to ${fav}.`, answer: fav / n });
  }
  const safe = [
    [4, 3],
    [5, 4],
    [7, 6],
    [9, 4],
    [10, 3],
  ];
  const [sum, count] = R.pick(safe);
  return numQ({ prompt: `Two fair 6-sided dice are rolled. Find the probability that the sum is ${sum}.`, answer: count / 36 });
}

const GRADE10_TOPICS = [
  { topic: 'quadratic-factor', gen: g10_quadraticFactor },
  { topic: 'composite-shape', gen: g10_compositeShape },
  { topic: 'circle', gen: g10_circle },
  { topic: 'volume', gen: g10_volume },
  { topic: 'distance', gen: g10_distance },
  { topic: 'midpoint', gen: g10_midpoint },
  { topic: 'similar-triangles', gen: g10_similarTriangles },
  { topic: 'simplify-radicals', gen: g10_radicals },
  { topic: 'vertex', gen: g10_vertex },
  { topic: 'polygon-angles', gen: g10_polygonAngles },
  { topic: 'probability', gen: g10_probability },
];

// ===========================================================================
// GRADE 11
// ===========================================================================

const TRIG_TABLE = [
  ['sin', 0, '0'], ['cos', 0, '1'], ['tan', 0, '0'],
  ['sin', 30, '1/2'], ['cos', 30, '√3/2'], ['tan', 30, '√3/3'],
  ['sin', 45, '√2/2'], ['cos', 45, '√2/2'], ['tan', 45, '1'],
  ['sin', 60, '√3/2'], ['cos', 60, '1/2'], ['tan', 60, '√3'],
  ['sin', 90, '1'], ['cos', 90, '0'],
  ['sin', 180, '0'], ['cos', 180, '−1'],
  ['sin', 270, '−1'], ['cos', 270, '0'],
];
const TRIG_VALUE_POOL = ['0', '1', '−1', '1/2', '−1/2', '√2/2', '√3/2', '√3/3', '√3'];

function g11_trigSpecial(R) {
  const [fn, angle, value] = R.pick(TRIG_TABLE);
  const distractors = R.shuffle(TRIG_VALUE_POOL.filter((v) => v !== value)).slice(0, 3);
  const { choices, answer } = buildChoices(R, value, distractors);
  return choiceQ({ prompt: `Find the exact value: ${fn} ${angle}°`, choices, answer });
}

function g11_degRad(R) {
  const degList = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330, 360];
  const deg = R.pick(degList);
  const correct = radianLabel(deg);
  const wrongDegs = degList.filter((d) => radianLabel(d) !== correct);
  const distractors = R.shuffle(wrongDegs.map(radianLabel).filter((v, i, a) => a.indexOf(v) === i)).slice(0, 3);
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Convert ${deg}° to radians.`, choices, answer });
}

function g11_logarithms(R) {
  const kind = R.pick(['base2', 'base3', 'base10', 'ln']);
  if (kind === 'base2') {
    const e = R.int(1, 8);
    return numQ({ prompt: `log${sub(2)}(${2 ** e}) = ?`, answer: e });
  }
  if (kind === 'base3') {
    const e = R.int(1, 5);
    return numQ({ prompt: `log${sub(3)}(${3 ** e}) = ?`, answer: e });
  }
  if (kind === 'base10') {
    const e = R.int(1, 5);
    return numQ({ prompt: `log(${10 ** e}) = ?`, answer: e });
  }
  const e = R.int(1, 5);
  return numQ({ prompt: `ln(e${powSup(e)}) = ?`, answer: e });
}

function g11_exponential(R) {
  const b = R.pick([2, 3, 4, 5]);
  const k = R.int(1, 6);
  const N = b ** k;
  if (R.chance(0.5)) {
    return numQ({ prompt: `Solve for x: ${b}^x = ${N}`, answer: k });
  }
  const c = R.nonZeroInt(-4, 4);
  const answer = k - c;
  return numQ({ prompt: `Solve for x: ${b}^(x ${term(c)}) = ${N}`, answer });
}

function g11_geometricSeq(R) {
  const a1 = R.nonZeroInt(-9, 9);
  const r = R.pick([2, 3, -2, -3]);
  const n = R.int(2, 5);
  if (R.chance(0.5)) {
    const answer = a1 * r ** (n - 1);
    return numQ({ prompt: `A geometric sequence has first term ${a1} and common ratio ${r}. Find the ${n}th term.`, answer });
  }
  const answer = (a1 * (r ** n - 1)) / (r - 1);
  return numQ({ prompt: `Find the sum of the first ${n} terms of a geometric series with first term ${a1} and common ratio ${r}.`, answer });
}

function g11_remainderTheorem(R) {
  const a = R.nonZeroInt(-4, 4);
  const b = R.int(-6, 6);
  const c = R.int(-6, 6);
  const d = R.int(-6, 6);
  const k = R.int(-4, 4);
  const answer = a * k ** 3 + b * k ** 2 + c * k + d;
  return numQ({
    prompt: `Let p(x) = ${leadX(a, '³')} ${midX(b, '²')} ${midX(c)} ${term(d)}. Find the remainder when p(x) is divided by (x ${term(-k)}).`,
    answer,
  });
}

function g11_complex(R) {
  if (R.chance(0.5)) {
    const n = R.int(1, 20);
    const cycle = ['i', '−1', '−i', '1'];
    const correct = cycle[n % 4];
    const distractors = cycle.filter((v) => v !== correct);
    const { choices, answer } = buildChoices(R, correct, distractors);
    return choiceQ({ prompt: `Simplify: i${powSup(n)}`, choices, answer });
  }
  const [p, q, r] = R.pick(TRIPLES);
  const signP = R.chance(0.5) ? p : -p;
  const signQ = R.chance(0.5) ? q : -q;
  return numQ({ prompt: `Find |${signP} ${signQ >= 0 ? '+' : '−'} ${Math.abs(signQ)}i|`, answer: r });
}

function g11_permCombo(R) {
  const kind = R.pick(['perm', 'combo', 'factorial-ratio']);
  const n = R.int(4, 10);
  if (kind === 'perm') {
    const r = R.int(1, Math.min(n, 5));
    return numQ({ prompt: `Evaluate P(${n}, ${r}) — the number of permutations of ${n} items taken ${r} at a time.`, answer: nPr(n, r) });
  }
  if (kind === 'combo') {
    const r = R.int(1, Math.min(n, 6));
    return numQ({ prompt: `Evaluate C(${n}, ${r}) — the number of combinations of ${n} items taken ${r} at a time.`, answer: nCr(n, r) });
  }
  const k = R.int(1, n - 1);
  return numQ({ prompt: `Evaluate ${n}! / ${k}!`, answer: nPr(n, n - k) });
}

function g11_binomial(R) {
  const n = R.int(2, 12);
  const k = R.int(0, n);
  return numQ({ prompt: `Find the binomial coefficient C(${n}, ${k}).`, answer: nCr(n, k) });
}

function g11_lawOfCosinesOrPolygon(R) {
  if (R.chance(0.4)) {
    const n = R.int(3, 20);
    return numQ({ prompt: `Find the sum of the interior angles (in degrees) of a convex ${n}-gon.`, answer: (n - 2) * 180 });
  }
  const build = () => {
    const angleOptions = [60, 90, 120];
    const C = R.pick(angleOptions);
    const cosC = C === 60 ? 0.5 : C === 90 ? 0 : -0.5;
    const a = R.int(3, 12);
    const b = R.int(3, 12);
    const c2 = a * a + b * b - 2 * a * b * cosC;
    const c = Math.sqrt(c2);
    if (!Number.isInteger(c) || c <= 0) return null;
    return { a, b, C, c };
  };
  const fallbackTriple = R.pick(TRIPLES);
  const { a, b, C, c } = retry(build, () => ({ a: fallbackTriple[0], b: fallbackTriple[1], C: 90, c: fallbackTriple[2] }));
  const correct = `${c}`;
  const distractors = [
    `${Math.round(Math.sqrt(a * a + b * b))}`,
    `${a + b}`,
    `${Math.abs(a - b)}`,
  ];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `In triangle ABC, a = ${a}, b = ${b}, and the included angle C = ${C}°. Find side c (law of cosines).`, choices, answer });
}

function g11_functionComposition(R) {
  const a = R.nonZeroInt(-5, 5);
  const b = R.int(-9, 9);
  const c = R.nonZeroInt(-5, 5);
  const d = R.int(-9, 9);
  const k = R.int(-5, 5);
  const gk = c * k + d;
  const answer = a * gk + b;
  return numQ({
    prompt: `Let f(x) = ${leadX(a)} ${term(b)} and g(x) = ${leadX(c)} ${term(d)}. Find f(g(${sn(k)})).`,
    answer,
  });
}

function g11_inverseFunction(R) {
  const a = R.nonZeroInt(-6, 6);
  if (Math.abs(a) === 1) return g11_inverseFunction2(R);
  const b = R.int(-9, 9);
  const k = R.int(-8, 8);
  const v = a * k + b;
  return numQ({ prompt: `Let f(x) = ${leadX(a)} ${term(b)}. Find f⁻¹(${sn(v)}).`, answer: k });
}
function g11_inverseFunction2(R) {
  const a = R.pick([2, 3, 4, 5, -2, -3, -4, -5]);
  const b = R.int(-9, 9);
  const k = R.int(-8, 8);
  const v = a * k + b;
  return numQ({ prompt: `Let f(x) = ${leadX(a)} ${term(b)}. Find f⁻¹(${sn(v)}).`, answer: k });
}

const GRADE11_TOPICS = [
  { topic: 'trig-special', gen: g11_trigSpecial },
  { topic: 'deg-rad', gen: g11_degRad },
  { topic: 'logarithms', gen: g11_logarithms },
  { topic: 'exponential-eq', gen: g11_exponential },
  { topic: 'geometric-sequence', gen: g11_geometricSeq },
  { topic: 'remainder-theorem', gen: g11_remainderTheorem },
  { topic: 'complex-numbers', gen: g11_complex },
  { topic: 'permutations-combinations', gen: g11_permCombo },
  { topic: 'binomial-coefficient', gen: g11_binomial },
  { topic: 'law-of-cosines', gen: g11_lawOfCosinesOrPolygon },
  { topic: 'function-composition', gen: g11_functionComposition },
  { topic: 'inverse-function', gen: g11_inverseFunction },
];

// ===========================================================================
// GRADE 12
// ===========================================================================

function g12_derivativePower(R) {
  const a = R.nonZeroInt(-6, 6);
  const n = R.int(2, 5);
  const correct = `${a * n}x${powSup(n - 1)}`;
  const distractors = [`${a}x${powSup(n - 1)}`, `${a * n}x${sup(n)}`, `${a * n}x${powSup(Math.max(0, n - 2))}`];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Find the derivative of f(x) = ${leadX(a)}${sup(n)}`, choices, answer });
}

function g12_derivativeAtPoint(R) {
  const a = R.nonZeroInt(-4, 4);
  const b = R.int(-6, 6);
  const c = R.int(-6, 6);
  const d = R.int(-6, 6);
  const x0 = R.int(-3, 3);
  const answer = 3 * a * x0 * x0 + 2 * b * x0 + c;
  return numQ({
    prompt: `Let f(x) = ${leadX(a, '³')} ${midX(b, '²')} ${midX(c)} ${term(d)}. Find f'(${sn(x0)}).`,
    answer,
  });
}

function g12_limits(R) {
  const k = R.int(-6, 6);
  const m = R.nonZeroInt(-6, 6);
  const B = m - k;
  const C = -k * m;
  const answer = k + m;
  return numQ({
    prompt: `Evaluate: lim(x→${k}) of (x² ${midX(B)} ${term(C)}) / (x ${term(-k)})`,
    answer,
  });
}

function g12_definiteIntegral(R) {
  const n = R.int(1, 3);
  const a = R.nonZeroInt(-5, 5) * (n + 1);
  const A = a / (n + 1);
  const p = R.int(-3, 3);
  let q = R.int(-3, 3);
  if (q === p) q = q + 1;
  const answer = A * (q ** (n + 1) - p ** (n + 1));
  return numQ({
    prompt: `Evaluate: ∫ from ${p} to ${q} of ${leadX(a)}${powSup(n)} dx`,
    answer,
  });
}

function g12_indefiniteIntegral(R) {
  const n = R.int(1, 4);
  const a = R.nonZeroInt(-6, 6) * (n + 1);
  const A = a / (n + 1);
  const correct = `${A}x${sup(n + 1)} + C`;
  const distractors = [`${a}x${sup(n + 1)} + C`, `${A}x${powSup(n)} + C`, `${A}x${sup(n + 1)}`];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Find the indefinite integral: ∫ ${leadX(a)}${powSup(n)} dx`, choices, answer });
}

function g12_chainRule(R) {
  const a = R.nonZeroInt(-4, 4);
  const b = R.int(-6, 6);
  const n = R.int(2, 5);
  const correct = `${n}(${leadX(a)} ${term(b)})${powSup(n - 1)} · ${a}`;
  const distractors = [
    `${n}(${leadX(a)} ${term(b)})${powSup(n - 1)}`,
    `(${leadX(a)} ${term(b)})${powSup(n - 1)} · ${a}`,
    `${n}(${leadX(a)} ${term(b)})${sup(n)} · ${a}`,
  ];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Find the derivative of f(x) = (${leadX(a)} ${term(b)})${sup(n)}`, choices, answer });
}

function g12_vectors(R) {
  if (R.chance(0.5)) {
    const a = R.int(-8, 8);
    const b = R.int(-8, 8);
    const c = R.int(-8, 8);
    const d = R.int(-8, 8);
    const e = R.int(-8, 8);
    const f = R.int(-8, 8);
    const answer = a * d + b * e + c * f;
    return numQ({ prompt: `Find the dot product of ⟨${a}, ${b}, ${c}⟩ and ⟨${d}, ${e}, ${f}⟩.`, answer });
  }
  const [p, q, r] = R.pick(TRIPLES);
  return numQ({ prompt: `Find the magnitude of the vector ⟨${p}, ${q}⟩.`, answer: r });
}

function g12_probabilityCombos(R) {
  const n = R.int(4, 12);
  const k = R.int(1, n - 1);
  return numQ({ prompt: `A bag has ${n} marbles, ${k} of which are red. One marble is drawn at random. Find the probability it is red.`, answer: k / n });
}

function g12_seriesSum(R) {
  if (R.chance(0.5)) {
    const a1 = R.int(-10, 10);
    const d = R.nonZeroInt(-8, 8);
    const n = R.pick([4, 6, 8, 10]);
    const answer = (n / 2) * (2 * a1 + (n - 1) * d);
    return numQ({ prompt: `Find the sum of the first ${n} terms of an arithmetic series with first term ${a1} and common difference ${d}.`, answer });
  }
  const a1 = R.nonZeroInt(-9, 9);
  const r = R.pick([2, 3, -2, -3]);
  const n = R.int(2, 5);
  const answer = (a1 * (r ** n - 1)) / (r - 1);
  return numQ({ prompt: `Find the sum of the first ${n} terms of a geometric series with first term ${a1} and common ratio ${r}.`, answer });
}

function g12_matrixDeterminant(R) {
  const a = R.int(-9, 9);
  const b = R.int(-9, 9);
  const c = R.int(-9, 9);
  const d = R.int(-9, 9);
  const answer = a * d - b * c;
  return numQ({ prompt: `Find the determinant of the matrix [[${a}, ${b}], [${c}, ${d}]].`, answer });
}

function g12_tangentSlope(R) {
  const a = R.nonZeroInt(-5, 5);
  const b = R.int(-8, 8);
  const c = R.int(-8, 8);
  const x0 = R.int(-5, 5);
  const answer = 2 * a * x0 + b;
  return numQ({
    prompt: `Let f(x) = ${leadX(a, '²')} ${midX(b)} ${term(c)}. Find the slope of the tangent line to f at x = ${sn(x0)}.`,
    answer,
  });
}

function g12_avgRateOfChange(R) {
  const a = R.nonZeroInt(-5, 5);
  const b = R.int(-8, 8);
  const c = R.int(-8, 8);
  const p = R.int(-6, 6);
  let q = R.int(-6, 6);
  if (q === p) q = q + 1;
  const answer = a * (p + q) + b;
  return numQ({
    prompt: `Let f(x) = ${leadX(a, '²')} ${midX(b)} ${term(c)}. Find the average rate of change of f on [${Math.min(p, q)}, ${Math.max(p, q)}].`,
    answer,
  });
}

function g12_logProperties(R) {
  const kind = R.pick(['product', 'quotient', 'power']);
  if (kind === 'product') {
    const correct = 'log a + log b';
    const distractors = ['log a − log b', 'log a · log b', 'log a / log b'];
    const { choices, answer } = buildChoices(R, correct, distractors);
    return choiceQ({ prompt: 'Which expression is equivalent to log(ab)?', choices, answer });
  }
  if (kind === 'quotient') {
    const correct = 'log a − log b';
    const distractors = ['log a + log b', 'log a · log b', 'log b − log a'];
    const { choices, answer } = buildChoices(R, correct, distractors);
    return choiceQ({ prompt: 'Which expression is equivalent to log(a/b)?', choices, answer });
  }
  const n = R.int(2, 5);
  const correct = `${n} log a`;
  const distractors = [`log(${n}a)`, `(log a)${sup(n)}`, `log a${sup(n)}`];
  const { choices, answer } = buildChoices(R, correct, distractors);
  return choiceQ({ prompt: `Which expression is equivalent to log(a${sup(n)})?`, choices, answer });
}

function g12_secondDerivative(R) {
  const a = R.nonZeroInt(-4, 4);
  const b = R.int(-6, 6);
  const c = R.int(-6, 6);
  const d = R.int(-6, 6);
  const x0 = R.int(-4, 4);
  const answer = 6 * a * x0 + 2 * b;
  return numQ({
    prompt: `Let f(x) = ${leadX(a, '³')} ${midX(b, '²')} ${midX(c)} ${term(d)}. Find f''(${sn(x0)}).`,
    answer,
  });
}

const GRADE12_TOPICS = [
  { topic: 'derivative-power-rule', gen: g12_derivativePower },
  { topic: 'derivative-at-point', gen: g12_derivativeAtPoint },
  { topic: 'limits', gen: g12_limits },
  { topic: 'definite-integral', gen: g12_definiteIntegral },
  { topic: 'indefinite-integral', gen: g12_indefiniteIntegral },
  { topic: 'chain-rule', gen: g12_chainRule },
  { topic: 'vectors', gen: g12_vectors },
  { topic: 'probability-combinations', gen: g12_probabilityCombos },
  { topic: 'series-sum', gen: g12_seriesSum },
  { topic: 'matrix-determinant', gen: g12_matrixDeterminant },
  { topic: 'tangent-slope', gen: g12_tangentSlope },
  { topic: 'average-rate-of-change', gen: g12_avgRateOfChange },
  { topic: 'log-properties', gen: g12_logProperties },
  { topic: 'second-derivative', gen: g12_secondDerivative },
];

const TOPICS_BY_GRADE = {
  8: GRADE8_TOPICS,
  9: GRADE9_TOPICS,
  10: GRADE10_TOPICS,
  11: GRADE11_TOPICS,
  12: GRADE12_TOPICS,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateQuestion(R, grade) {
  const g = grade === 'mixed' ? R.pick(GRADES) : grade;
  const topics = TOPICS_BY_GRADE[g];
  if (!topics) throw new Error(`Unknown grade: ${grade}`);
  const entry = R.pick(topics);
  const q = entry.gen(R);
  q.grade = g;
  q.topic = entry.topic;
  return q;
}

export function parseNumeric(str) {
  if (typeof str !== 'string') return NaN;
  if (str.length === 0 || str.length > 32) return NaN;
  const s = str.trim();
  if (s.length === 0 || s.length > 32) return NaN;
  const fracMatch = /^-?\d+\/\d+$/.exec(s);
  if (fracMatch) {
    const [nStr, dStr] = s.split('/');
    const n = Number(nStr);
    const d = Number(dStr);
    if (d === 0) return NaN;
    return n / d;
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

export function checkAnswer(question, rawInput) {
  try {
    if (!question || typeof question !== 'object') return false;
    if (question.kind === 'numeric') {
      let v;
      if (typeof rawInput === 'number') v = rawInput;
      else if (typeof rawInput === 'string') v = parseNumeric(rawInput);
      else return false;
      if (!Number.isFinite(v)) return false;
      const tol = question.tolerance ?? 1e-6;
      return Math.abs(v - question.answer) <= tol;
    }
    if (question.kind === 'choice') {
      if (!Array.isArray(question.choices)) return false;
      let idx;
      if (typeof rawInput === 'number') {
        idx = rawInput;
      } else if (typeof rawInput === 'string') {
        if (rawInput.length > 32) return false;
        const trimmed = rawInput.trim();
        if (!/^-?\d+$/.test(trimmed)) return false;
        idx = Number(trimmed);
      } else {
        return false;
      }
      if (!Number.isInteger(idx)) return false;
      if (idx < 0 || idx >= question.choices.length) return false;
      return idx === question.answer;
    }
    return false;
  } catch {
    return false;
  }
}

export function formatAnswer(question) {
  if (!question || typeof question !== 'object') return '';
  if (question.kind === 'choice') {
    return String(question.choices[question.answer]);
  }
  const x = question.answer;
  if (Number.isInteger(x)) return String(x);
  if (Math.abs(x * 100 - Math.round(x * 100)) < 1e-6) {
    const fixed = (Math.round(x * 100) / 100).toString();
    return fixed;
  }
  for (let k = 2; k <= 12; k++) {
    const v = x * k;
    if (Math.abs(v - Math.round(v)) < 1e-6) {
      const num = Math.round(v);
      const g = gcd(num, k) || 1;
      return `${num / g}/${k / g}`;
    }
  }
  return String(x);
}
