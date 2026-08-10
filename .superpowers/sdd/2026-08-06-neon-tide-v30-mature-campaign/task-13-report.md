# Task 13 report — Data City and Protocol Zero

## Status
ROUND 1 FIXES COMMITTED WITH ONE OPEN BROWSER ACCEPTANCE FAILURE.

The review fixes are implemented and the complete deterministic Node 22 suite, production build, syntax checks, and whitespace checks pass. The final Standard headful scenario naturally completes all three Data City rooms and the Protocol Zero firewall, but the run still loses the player during the truthful-cell traffic-grid traversal. Abyss headful acceptance and the production cold-checkpoint probe were not rerun after that failure.

## Round 1 fixes delivered

### Data City gameplay semantics
- Data-lane beats now author an explicit center/half-width, `0.78` steering multiplier, `0.65` dash-recovery **rate** multiplier, and zero direct damage.
- The legacy runtime consumes the Director's authored lane contract; pause freezes charge recovery.
- Escort safe-route beats replace the real escort route while retaining already-earned progress.
- Storm safe-route/route-change beats replace the real corridor, safe zone, next safe zone, direction, and presentation warning.
- Dual-crisis beats change only the real crosslink priority/radius and preserve crisis positions.
- Compressed browser routes use reachable authored geometry. The production pacing contract remains unchanged.

### Protocol Zero fairness and presentation
- Firewall requires a center handshake before every alternating inner/outer marker. The marked destination is a real pooled world entity and a HUD presentation contract, not a debug-only answer.
- A fixed-radius circle bot cannot complete the firewall; a varied route can.
- Standard exposes one truthful safe cell by unique shape. Abyss retains non-color shape plus discrete rhythm evidence under forced colors/reduced motion.
- Safe-cell, clone-node, and firewall presentation spawns are transactional and bounded. Capacity exhaustion retries for at most 2.5 seconds and then fails closed instead of exposing an invisible answer.
- Protocol and Maw Boss ownership enforce a hard 48-entity ceiling, including reserve paths. Successful attack counts represent successful spawns only.
- Traffic/predictive geometry is checked across seeded timing combinations for a continuous player-radius route.
- Cleanup remains idempotent and clears mixed pooled geometry, warnings, hazards, projectiles, presentation, and Boss ownership.

### Lazy loading and production isolation
- Data City content remains dynamically imported.
- Campaign room start/upgrade continuation awaits the required chapter chunk, preventing a cold-checkpoint race.
- The production probe now defines a legal Data City chapter-entry checkpoint and asserts production ignores malicious test/duration query authority while loading only the required chapter chunk.

## TDD evidence — round 1

### RED
- Lane browser probe initially used a zero-frame Space tap, then dashed vertically out of the horizontal lane. It therefore measured normal recovery. The probe now holds real `D + Space` input across animation frames so baseline remains outside the lane and the lane sample remains inside it.
- Escort lost its authored progress when the route changed. Adding a route-progress offset fixed the real objective timeout.
- Browser warning counting treated one Striker owner's three candidate lines as three simultaneous warnings. The acceptance now counts distinct warning owners, matching the authored warning contract.
- Natural accelerated Storm and Dual Crisis runs exposed physical route/travel pressure. Authored Storm points were brought into a reachable switchback while the core campaign work formula was left unchanged.
- Protocol pool-exhaustion tests exposed partially visible answer sets and transient ownership beyond the ceiling. Spawns are now transactional with bounded retry/fail-closed behavior.

### GREEN
- Project Node 22 deterministic suite passes `320/320`.
- Focused Data City/Protocol coverage includes explicit lane rate semantics, authored objective mutation, pause freeze, circle-bot rejection, varied firewall completion, pool exhaustion, hard ownership ceiling, seeded continuous-lane geometry, generation-safe kernel completion, and Abyss rhythm evidence.
- Production build, changed-file syntax checks, and `git diff --check` pass.

### Remaining RED
Final headful Standard run, Chrome `146.0.7680.80`, Vite `4174`, CDP `9360`, 150-second hard timeout:

- Naturally completed the three Data City rooms.
- Completed Protocol Zero firewall through real keyboard movement and world/HUD marker presentation.
- Entered `trafficGrid` and followed the truthful pooled cell with real keyboard/dash input.
- Failed when the player transitioned to `briefing` during that traversal:
  `Error: dash movement interrupted in briefing`.
- Consequently clone nodes, kernel, victory, cleanup assertions, Abyss headful acceptance, and the production cold-checkpoint browser probe are not claimed as passing in this round.

## Verification commands and actual output
All final deterministic commands used the project runtime:
`/Users/kanyun/Documents/zhanrui/threejs-neon-tide/.runtime/node-v22.14.0-darwin-arm64/bin/node` (`v22.14.0`).

- Full deterministic suite: `node --test` — PASS `320/320`, `5851.123458ms`.
- Production build: two Vite builds plus `tests/assert-build-output.mjs` — PASS.
  - Data City lazy chunk: `4.80 kB` minified / `1.87 kB` gzip; `6.93 kB` unminified.
  - Main entry: `15.63 kB` minified / `5.85 kB` gzip; unminified entry `31,661` bytes.
  - Gameplay core: `232.55 kB` minified / `73.63 kB` gzip; `460.62 kB` unminified.
  - Existing warning: Three.js vendor chunk `525.56 kB` minified.
- `node --check` — PASS for all `16` changed JS/MJS files.
- `git diff --check` — PASS.
- Final Standard browser batch — FAIL at traffic-grid survival as documented above.
- Abyss browser batch — NOT RUN after final Standard failure.
- Production cold-checkpoint browser probe — NOT RUN after final Standard failure.

## Process cleanup
Temporary `4174`, `4175`, `9333`, and `9360` listeners were verified closed. Existing `4173` (`Python`, PID `11284`) was not touched.

## Remaining concern
Protocol Zero's traffic-grid encounter is not yet proven survivable from the naturally depleted Standard campaign hull. The deterministic geometry proves a reachable lane and the presentation is visible, but the end-to-end headful run still reaches defeat/briefing during truthful-cell traversal. This must be resolved and the Standard, Abyss, and production browser probes rerun before Task 13 can be called fully accepted.
