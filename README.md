# MathDuel

Real-time 1v1 math race for grades 8-12. Both players get the same question at the same moment; the first correct answer takes the point, a wrong answer locks you out of that question, and ties go to sudden death.

**Play:** https://dizzysky1.github.io/mathduel/

## Modes

- **Online** – host a room, share the 6-character code, opponent joins. Peer-to-peer over WebRTC (PeerJS for signalling only). No accounts, no server storage.
- **Vs CPU** – three difficulty levels.
- **Pass & play** – two players share one device; each gets an independent question stream so nobody sees the other's answers.

## Question bank

Procedurally generated per match from a shared seed, so the two peers never have to trust each other's questions. Roughly 8-12 topics per grade:

| Grade | Topics (sample) |
|---|---|
| 8 | integer ops, 1-2 step equations, percent, ratios, exponents, Pythagorean triples, slope |
| 9 | multi-step equations, 2×2 systems, exponent rules, factoring, absolute value, inequalities, sequences |
| 10 | quadratics, area/volume in π, distance/midpoint, radicals, vertex form, polygon angles, probability |
| 11 | exact trig values, radians, logs, exponential equations, series, remainder theorem, complex numbers, nPr/nCr |
| 12 | power/product/chain rule, limits, definite & indefinite integrals, vectors, determinants, series |

Numeric answers accept integers, decimals, or fractions (`3/4`). Multiple-choice questions answer with keys 1-4.

## Run locally

No build step, no dependencies.

```bash
npm test          # node:test suite
npm run serve     # http://localhost:3019
```

## Security model

See [SECURITY.md](SECURITY.md). Short version: the host is authoritative for *ordering* (who answered first), but every claim it makes about *correctness* is re-verified by the guest against its own copy of the question, and the question seed is fixed by a commit-reveal exchange so neither side can pick the questions.

## Layout

```
index.html          UI shell (CSP, no inline script)
style.css
src/rng.js          seeded PRNG
src/questions.js    generators for all grades + answer checking
src/match.js        match state machine (pure)
src/protocol.js     message schemas + validation
src/net.js          PeerJS wrapper (validation, rate limit)
src/main.js         UI controller for all three modes
vendor/peerjs.min.js  pinned peerjs@1.5.4 (hash in vendor/INTEGRITY, checked in CI)
test/               node:test suites
.github/workflows   CI + GitHub Pages deploy
```

MIT.
