# Task 13 report — Data City and Protocol Zero

## Status
ROUND 2: ITEM 9 CLOSED DETERMINISTICALLY; ITEM 8 STILL OPEN IN BROWSER ACCEPTANCE.

The current-player→truthful-cell temporal corridor contract, deterministic sequence coverage, complete Node 22 suite, production build, syntax checks, and production cold-checkpoint probe pass. The final Standard/Abyss headful batch stopped in the pre-Boss data-lane measurement, so natural Standard/Abyss Boss victory and cleanup are not claimed.

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
Protocol Zero's traffic-grid encounter is not yet proven by the Standard/Abyss headful campaign path because the final browser batch stopped earlier in the Data City lane measurement. The deterministic traffic contract is green, but browser item 8 remains open until a natural three-room run reaches firewall, traffic grid, clone nodes, kernel, victory, and cleanup.

## Round 2 review — items 8 and 9

### RED evidence
- The pre-fix deterministic proof only asked whether any bottom-edge grid point could reach any top-edge grid point. It did not use the player's actual position, truthful-cell target, speed, or time sequence.
- The first round-2 browser diagnostic with `duration-scale=0.1` reached the Storm room's final authored segment with `hull=4`, `progress=5.599999999999985/5.848000000000001`, `stormExposure=0`, then restored to the chapter-entry briefing. A second diagnostic with `duration-scale=0.2` restored to the same briefing while attempting the Dual Crisis room. Neither reached Protocol traffic, so no traffic hazard snapshot is claimed from those probes.
- The final single headful batch used `duration-scale=0.15` and failed before any Data City room/Boss acceptance at `measureDataLaneRecovery` line 227: environment phase was `active`, but the real player had not settled within the lane-center tolerance. The Standard, Abyss, and Boss-victory browser assertions therefore remain unverified in this round.

### GREEN implementation
- `createProtocolTrafficCorridor(start, target, arena, bodyRadius, playerRadius)` creates a conservative waypoint contract from the **current player position** to the current truthful cell. It includes a player-radius-plus-margin clearance and detours around the Protocol body.
- `protocolTemporalRouteReachesTruthfulCell({ corridor, frames, speed, dt })` advances a bounded player-radius body over consecutive frames and rejects any warning/hazard intersection or incomplete target arrival. The proof is temporal, not a single-frame bottom-to-top BFS.
- Traffic-grid generation publishes `safeRoute.start`, `safeRoute.target`, `safeRoute.waypoints`, and `safeRoute.clearance`. On every truthful-cell transition, old Protocol traffic warnings/hazards are removed and the contract is regenerated from the actual player position.
- `grid-lock`, `traffic-wall`, and `predictive-beam` spawns are rejected before materialization whenever their oriented geometry intersects the committed corridor. Traffic-wall safe-lane selection no longer adds `attackCursor`, so attack sequencing cannot drift the open lane away from the truthful cell. The corridor remains fixed across warning→active frames.
- The deterministic test now covers 12 seeds × 4 truthful-cell rounds, all three traffic attack variants, timing offsets, actual player starts, and a localized corridor-seal synthetic RED case. It passes.

### Round 2 verification
- Project Node 22 full deterministic suite: `node --test` — PASS `321/321` (`5329.587041ms`).
- Focused Data City/Protocol tests: `node --test tests/data-city-chapter.test.mjs tests/boss-system.test.mjs` — PASS `26/26`.
- Production build plus `tests/assert-build-output.mjs dist-unminified` — PASS. Data City lazy chunk `4.80 kB` minified / `1.87 kB` gzip; unminified entry `31,661` bytes.
- Changed-file syntax: `3/3` JS/MJS files — PASS. `git diff --check` — PASS.
- Production browser cold-checkpoint batch on `4175`/CDP `9360`, 150-second hard timeout — PASS `2/2`:
  - release authority isolation and direct settlement rejection;
  - Data City lazy checkpoint await with no test authority and malicious duration query ignored.
- Final Standard/Abyss browser batch on `4174`/CDP `9360`, 150-second hard timeout — NOT PASS: Standard stopped at `measureDataLaneRecovery` line 227 before Data City room/Boss traversal; Abyss was not reached. No browser victory/cleanup claim is made.

### Round 2 process state
Temporary `4174`, `4175`, and `9360` listeners were stopped and verified closed. Existing `4173` PID `11284` was not touched; `9333` was not used. The remaining item is browser item 8 only; item 9's deterministic temporal contract is green.
