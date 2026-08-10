# Task 13 report — Data City and Protocol Zero

## Status
DONE — Data City now has a lazy-loaded introduce → develop → test chapter, real data-lane handling, bounded authored enemy/warning pacing, and a separately dispatched Protocol Zero Boss. Standard and Abyss browser acceptance reach the Boss through the campaign, clear its real movement gates, expose real collision targets, and preserve cleanup/production isolation.

## Delivered

### Data City chapter
- Added a deeply immutable three-room chapter definition:
  1. `escort-skiff` / introduce — Striker then Lancer, two-warning cap, explicit escort inner rail and billboard cutback.
  2. `storm-run` / develop — Warden introduced into alternating corridor and maintenance-gap routing, two-warning cap.
  3. `dual-crisis` / test — Interceptor added to learned Striker/Lancer/Warden combinations, opposite-quadrant relief, three-warning cap.
- Authored role windows reserve future introduction slots, carry learned roles forward, and keep active-enemy caps at 30/36/44.
- Data-lane exposure has `directDamage: 0`, multiplies steering response by `0.78`, and dash recovery by `0.65`. Objective updates at zero simulation time leave escort route/HP/progress and storm corridor/progress/exposure/telegraph state unchanged.
- Data City content remains behind the existing lazy chapter chunk. A bounded registry exposes only already-loaded chapter/Boss definitions to the Director, and the next chapter is prefetched when the current campaign Boss begins so production input cannot race the lazy boundary.

### Protocol Zero
- Added a dedicated Protocol Zero implementation selected by a small `createBossSystem` dispatcher; Abyss Maw remains in its own implementation and does not share Protocol phase branches.
- Four outcome-driven phases:
  - `firewall`: four marked quadrant entries; waiting does not advance.
  - `trafficGrid`: four truthful-cell outcomes; Standard has exactly one uniquely shaped truthful cell.
  - `cloneNodes`: three real auto-targetable/collidable weak points rendered through distinct pooled geometry families (diamond enemy, hexagonal Boss part, ring objective).
  - `kernel`: the real core becomes the final weak point and completes only from collision-authored health outcome.
- Abyss adds decoys while retaining both shape and pulse-beat evidence. Forced-colors/reduced-motion browser coverage verifies the evidence is not color-only.
- Grid locks, traffic walls, clone bursts, and predictive beams use real warning → hazard entities. Traffic walls leave one full column open; predictive beams retain a center gap; the public safe-route contract never reports zero open lanes.
- Collision-authored lethal records are consumed before capacity retry. If CollisionSystem has already generation-safely despawned the core, its retained handle completes the Boss instead of respawning a fresh kernel.
- Boss-owned parts, enemies, objectives, warnings, hazards, and projectiles have explicit bounded ownership. Damage telemetry is limited to four known weapon buckets plus `other`.
- Cleanup is idempotent and clears Boss parts, mixed-shape clone nodes, safe-cell objectives, warnings, hazards, projectiles, music, and objective presentation.

## TDD evidence

### RED
- Initial focused run failed with `ERR_MODULE_NOT_FOUND` for `src/content/chapters/data-city.js`.
- Browser RED exposed a real authority defect: CollisionSystem despawned a lethal kernel before BossSystem consumed the same-step record; Protocol Zero retried capacity first, replaced the kernel handle, and could never settle the real victory.
- Browser RED also showed that merely carrying shape strings was insufficient for a visible forced-colors contract; truthful cells and clone nodes were then materialized with distinct existing pooled geometry families.

### GREEN
- Added immutable chapter/Boss content, lane semantics, lazy registration, authored Director beats, outcome gates, real pooled attacks/weak points, and cleanup.
- Reordered Protocol damage consumption ahead of spawn retry and added a generation-safe lethal-record regression.
- Standard real-keyboard traversal, real `E` input, WeaponSystem targeting, CollisionSystem damage, automatic fire, victory, and cleanup pass; Abyss decoy evidence passes under forced colors and reduced motion.

## Verification
All commands used Node `22.14.0` from the requested runtime.

- Focused logic: `node --test tests/data-city-chapter.test.mjs tests/boss-system.test.mjs tests/abyss-chapter.test.mjs` — PASS; final Data City file `7/7`.
- Full deterministic suite: `npm test` — PASS `315/315` in `5.634s`.
- Production build: `npm run build` — PASS.
  - Data City lazy chunk: `4.24 kB` minified / `1.68 kB` gzip; `5.69 kB` unminified.
  - Main entry: `15.53 kB` minified / `5.81 kB` gzip.
  - Unminified main entry: `31,496` bytes, below the `500,000` byte ceiling.
  - Gameplay core: `225.93 kB` minified / `71.53 kB` gzip; `446.90 kB` unminified.
- `node --check` — PASS for all `12` changed JS/MJS files.
- `git diff --check` — PASS.
- Bounded stress probe — PASS: Abyss traffic grid observed maximum `12` Boss-owned entities, maximum `4` simultaneous warnings, and `0` spawn failures; configured hard owner ceiling is `48`. Standard browser acceptance asserts warning maximum `<=3`.
- Headful Chrome `146.0.7680.80`, temporary Vite `4174`, CDP `9360`, `150s` hard timeout, `BROWSER_MATRIX_SCENARIO='Protocol Zero'` — PASS `2/2`:
  - Standard truthful grid + real weapon victory: `18.307s`.
  - Abyss shape/rhythm decoys: `8.121s`.
- Browser path used DEV `campaignTest.completeCurrentNode()` only to traverse prerequisite campaign nodes. Protocol phases/HP/player position were never assigned; quadrant/cell movement used keyboard input, and node/core damage used real `E`, automatic weapons, WeaponSystem selection, and CollisionSystem records. No kill projectile was fabricated.
- Final production preview `4175` with `?campaign-test=1&boss-test=1`, headful production probe — PASS `1/1`: no `campaignTest`, `bossTest`, or `repairHull` authority; no test combat telemetry; lazy later-chapter chunks absent at initial load; direct campaign settlement rejected.
- Temporary `4174`, `4175`, and `9360` processes were stopped and verified closed. Existing `4173` was not touched; `9333` was not used.

## Remaining concerns
- No unresolved Task 13 functional or authority concern remains. The existing Vite warning still applies only to the separately cached Three.js vendor chunk (`525.56 kB` minified); the application entry and Data City lazy boundary remain within budget.
