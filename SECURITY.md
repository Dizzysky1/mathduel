# Security

MathDuel is a static site with no backend of its own. Online matches are peer-to-peer WebRTC data channels; the only third party is the public PeerJS signalling server, which sees peer ids and the SDP/ICE handshake but never game traffic.

## Threat model

The opponent is untrusted. They may run a modified client and send arbitrary messages.

| Threat | Mitigation |
|---|---|
| Injected HTML / XSS via opponent name or answers | All peer strings reach the DOM through `textContent` only. CI fails on any `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` in app code. Strict CSP: no inline scripts, `default-src 'none'`. |
| Malformed or oversized messages | Every inbound message is schema-validated and clamped (`src/protocol.js`); unknown fields are dropped, unknown types ignored. Decoded payloads over 4 KB, non-objects and binary are discarded. |
| BinaryPack chunk-buffer exhaustion in PeerJS | The connecting peer chooses the serialization, so the host refuses any connection that is not `json` (the JSON serializer never chunks). |
| Message floods | Token-bucket rate limit per connection; excess is dropped silently. |
| Prototype pollution via `__proto__` keys | Validators copy only known fields into fresh objects; nothing is merged from peer data. |
| Host picks favourable questions | Commit-reveal seed: host sends `sha256(hostNonce)` before learning the guest nonce; seed = hash(hostNonce ‖ guestNonce). Guest verifies the reveal. |
| Host claims a point with a wrong answer | Guest generates the identical question list and re-checks every `result` the host sends. A false claim voids the match. |
| Host buries the guest's correct answer ("nobody scored") or skips the question | Guest remembers its own verdict per question; a `result` that is not "guest won" or "host was correct and first", or a `next` while a claim is pending, voids the match. The guest also ignores the host's echo of the guest's own answer. |
| Host ends the match early while ahead | `gameover` is only accepted when the guest's mirror agrees the match is finished (rounds and sudden-death cap included). |
| Host stalls forever (crash, backgrounded tab, malice) | Timers use `setTimeout` deadlines, not `requestAnimationFrame`; guest arms a watchdog per phase and aborts if the host goes quiet. |
| Peer vanishes without a WebRTC close event | Application-level ping/pong heartbeat; 10 s of silence ends the match. |
| Handshake replay mid-match (`hello`/`start`/`rematch` out of phase) | Every handshake message is gated on phase and one-shot flags; the `start` verification holds a claim flag across its `await`. |
| Host reports a bogus final score | Guest compares `gameover` with its own mirror; mismatch voids the match. |
| Out-of-order / replayed `next` or `result` | Question index must match the mirror's expected index. |
| Guest submits after being locked out | Host's match state rejects it. |
| Room brute-forcing | 30-bit random codes from `crypto.getRandomValues`, only live while a host is waiting, one opponent per room. |
| Name spoofing with bidi / zero-width chars | Stripped by `sanitizeName`, names clamped to 16 chars. |
| Supply chain (PeerJS) | Vendored, version pinned, SHA-384 recorded in `vendor/INTEGRITY`, enforced by the browser via an SRI `integrity` attribute, and re-verified in both CI and the deploy job before anything is published. No CDN at runtime. GitHub Actions are pinned to commit SHAs; only the deploy job holds `pages: write`. |
| Path traversal in dev server | Path is normalised, then `realpath`-resolved (symlinks followed) and must stay inside the project root. Dev only; production is GitHub Pages. |

## Known limitations (by design of a serverless P2P game)

- **Answer lookup.** Every client can compute the answer to every question; a modified client could auto-answer. This is unavoidable without an authoritative server and is accepted for a casual game.
- **Ordering fairness.** The host decides who answered first based on arrival time, so the host has a latency edge and a modified host could favour itself on close races. Correctness cannot be faked, only the tie-break on timing.
- **IP exposure.** WebRTC reveals peers' IP addresses to each other, as in any P2P game.
- **Signalling availability.** The public PeerJS server is a shared free service; STUN only, so some symmetric-NAT networks cannot connect.

## Reporting

Open a GitHub issue or contact the repository owner. Please do not include exploit details in public issues for anything that affects other players.
