// Deterministic PRNG utilities. Both peers derive the same question sequence
// from a shared seed, so neither side has to trust the other's questions.

/** mulberry32: small, fast, deterministic 32-bit PRNG. Returns () => [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash an arbitrary string to a 32-bit seed (FNV-1a). */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Helpers layered on a [0,1) generator. */
export function makeRandom(next) {
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  const nonZeroInt = (lo, hi) => {
    let v = 0;
    do v = int(lo, hi); while (v === 0);
    return v;
  };
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const chance = (p) => next() < p;
  return { next, int, pick, nonZeroInt, shuffle, chance };
}
