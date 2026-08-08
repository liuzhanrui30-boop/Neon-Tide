# Task 9 report — Predictive enemy roles and threat budgeting

## Status
DONE — strict SDD/TDD implementation and final verification complete.

## Commit
- `feat: add predictive enemy roles and threat budgeting` (this task commit)

## Delivered
- Added an immutable eight-role roster for Hunter, Interceptor, Striker, Lancer, Swarm, Mine, Warden, and Bulwark. Every role locks speed range, threat cost, chapter gate, warning duration, active cap, counterplay, damage, health, and area/projectile costs; all high-damage telegraphs are at least 0.55 seconds.
- Added the pooled authoritative enemy system through `EntityWorld`, collision, render, session, and encounter ownership rather than legacy-only spawn hooks:
  - bounded predictive Hunter pursuit;
  - 35–55 degree Interceptor route cuts using anti-orbit context;
  - independent three-line Striker previews;
  - Lancer beams with a visible cyan safe sector and capped slow projectile groups;
  - Swarm split/merge formations;
  - delayed Mine arming and minimum 0.45-second chain warnings;
  - Warden moving walls with a guaranteed non-damaging gap wider than the player body;
  - Bulwark dash/Tide Lance armor breaks, one counter token per attack, readable counter rings, and execution protection.
- Added preallocated `warning` and `enemyHazard` world/render pools. Warning slots own independent materials and progress, remain visibly represented while active, and do not allocate geometry or materials during gameplay.
- Added deterministic `selectThreatWave(context, random)` budgeting with exact Standard/Abyss desktop/coarse caps, role caps, chapter gates, objective burden, health relief, clear-rate/untouched mastery pressure, blocked-area budget, projectile density, and prospective high-damage warning admission.
- Added runtime attack admission so already-spawned roles cannot later exceed the simultaneous high-damage warning cap. Wave spawning now materializes exactly the selected roles, including Swarm, without hidden active-cap inflation.
- Integrated natural threat waves into the Task 7 encounter lifecycle without disabling objectives or Task 8 anti-orbit pressure. Terminal objectives clean enemies, warnings, hazards, and enemy projectiles; elite targets retain stable authoritative source IDs.
- Bridged real dash and Tide Lance tokens/directions from the production runtime, disabled duplicate legacy objective enemies for authoritative rooms, and routed enemy destruction back into objective input.
- Added deterministic unit coverage for all eight behaviors, collision/execution contracts, warning visibility/ownership, hard caps, dynamic relief, exact spawn counts, and 256 seeded wave-selection sweeps that naturally reach all roles.
- Added and registered a headful CDP browser scenario using real keyboard/dash input. It reaches all eight roles through the natural campaign encounter lifecycle and proves concurrent warnings have independent owners/progress, positive opacity, non-colliding preview state, and zero renderer-hidden active warnings.

## Verification
All Node/npm commands used the required Node 22.14.0 runtime:
`PATH=/Users/kanyun/Documents/zhanrui/threejs-neon-tide/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH`

Port 4173 was not touched. Browser validation used Vite on temporary port 4174 and isolated headful Chrome 146.0.7680.80 on CDP 9358.

- Focused enemy/threat tests — PASS: 17/17 after final cap regressions.
- Seeded threat selection — PASS: 256 seeds × 24 waves, finite and within active-enemy, warning, blocked-area, projectile, role, and chapter budgets; all eight roles reached.
- Final `npm run check` — PASS: 205/205 Node tests plus production build.
- Focused natural enemy browser acceptance — PASS: 1/1.
- Existing natural objective browser acceptance with enemy pressure — PASS: 1/1.
- Existing natural anti-orbit browser acceptance with enemy pressure — PASS: 1/1.
- Full browser matrix — PASS: 30/30 in one final run.
- Breakpoint cleanup self-test — PASS: 1/1.
- `git diff --check` — PASS.

## Concerns
- Vite retains the inherited large-chunk warning; the main production bundle is 848.79 kB minified (235.40 kB gzip). Code splitting remains outside Task 9.
- One earlier monolithic browser run exposed the inherited core-harvest transition-grace timing edge while staging the boundary-orbit proof. The focused objective scenario then passed, and the subsequent final 30/30 matrix passed in one run without code changes to objective timing.

---

## Review fix round 1/5 — Fair enemy threat contracts

### Status
DONE — all requested Critical, Important, and allocation findings are fixed and covered by final regression evidence.

### Correctness and fairness fixes
- Removed low-hull mutation of live enemy bodies, projectiles, and hazards. Hull relief now changes only future wave composition cost: Standard stops admitting new combinations at or below 40% hull, while Abyss retains a reduced positive budget. Existing and newly committed threats stay collidable and damaging before and after healing.
- Kept body and hazard pressure playable without cancelling it: ordinary body contact uses a bounded 0.1 base hit with deterministic cooldown, committed dash states restore authored role damage, and one owner-group hazard hit is accepted per cooldown window.
- Made the Lancer preview and active beam share one authoritative node layout. The preview is centered on the future beam and includes the complete first-to-last node footprint plus node radii; renderer observations prove every rendered node remains inside the rendered warning.
- Corrected the Interceptor fallback cross-product sign for both clockwise and counter-clockwise angular motion.
- Enforced exact runtime device caps. Coarse worlds allocate 42 enemies and 72 enemy projectiles; Standard/Abyss coarse directors admit 36/42 enemies, 72 projectiles, and 2/3 warning owners respectively. EnemySystem exposes and enforces the same limits.
- Expanded blocked-area accounting to live collidable hazards for Lancer, Mine, Warden, and Bulwark, deduplicated by owner across warning/active phases, so prospective waves cannot hide already-committed area pressure.
- Protected lethal-hit execution through every committed active state (`cut-dash`, `strike-dash`, `beam-active`, `detonate`, `wall-active`, and `counter-active`) and cleaned each owner/hazard group exactly once after its authored duration.
- Prevented Bulwark dash/Tide Lance tokens from restarting or replacing an in-progress counter. Armor breaks are accepted only from the armored chase state.
- Raised Mine chain warning floor to 0.55 seconds and preserved any longer arming warning already in progress.
- Matched rendered hazard transforms to authoritative radius/scale for Warden wall nodes, Warden gaps, and the Lancer safe sector without changing ownership or collision flags.
- Made Warden materialization immediately request its fair telegraph admission. This prevents ordinary auto-fire from removing a newly introduced chapter-two Warden before its readable safe-gap contract can appear.
- Changed `rolesSeen` and threat-wave telemetry to record only successfully materialized enemies. Browser acceptance now uses stable renderer observations of actual pooled roles, warning concurrency/progress, Lancer containment, and Warden/Lancer safe geometry rather than selected or rejected roster entries.

### Allocation fixes
- Removed transient normalization and prediction objects from fixed-step Hunter, steering, and Swarm paths.
- Reused one compact EnemySystem update summary and destroyed-record buffer across fixed steps.
- Kept renderer acceptance telemetry bounded with preallocated scalar/typed-array observations rather than per-frame geometry snapshots.

### Regression coverage
- Added actual low-hull → heal collision probes for enemy body, projectile, and hazard damage.
- Added exact Lancer transform containment, both Interceptor rotation signs, live blocked-area admission, all committed execution states, Bulwark token replay, natural Mine warning preservation, authoritative renderer radius decomposition, materialization-only `rolesSeen`, exact compact caps, and 600-step update-result reuse tests.
- The headful enemy scenario reaches all eight actually rendered roles through the natural campaign using real WASD/dash input, observes at least two independent concurrent warning owners, and verifies zero hidden warnings plus rendered Lancer/Warden safe-path parity. A second compact scenario proves Standard and Abyss caps end to end.

### Verification
All Node/npm commands used Node 22.14.0 from the required runtime. Port 4173 remained untouched; browser validation used temporary Vite port 4174 and isolated headful Chrome 146.0.7680.80 on CDP 9358.

- Focused enemy/director/collision/world/renderer tests — PASS: 63/63.
- Seeded threat stress — PASS: 256 seeds × 24 waves, finite and within all hard budgets, with every role naturally reachable.
- Final `npm run check` — PASS: 219/219 Node tests and production build.
- Focused natural enemy acceptance — PASS: 1/1.
- Focused compact Standard/Abyss cap acceptance — PASS: 1/1.
- Natural objective acceptance under enemy pressure — PASS in the final full matrix.
- Natural anti-orbit acceptance under enemy pressure — PASS in the final full matrix.
- Full browser matrix — PASS: 31/31 in one final run.
- Breakpoint cleanup failure-path self-test — PASS: 1/1.
- `git diff --check` — PASS.

### Concerns
- Vite retains the inherited large-chunk warning; the final main bundle is 852.08 kB minified (236.64 kB gzip). Code splitting remains outside Task 9.
- Standard low-hull relief intentionally pauses future wave admission at or below 40% hull rather than weakening live threats. Abyss retains reduced future admission. This is deterministic and fully covered, but remains a tuning lever for later playtesting.

---

## Review fix round 2/5 — Complete committed enemy executions

### Status
DONE — the remaining three Important findings and renderer/collision footprint hardening are implemented and verified.

### Delivered
- Unified enemy execution protection behind shared helpers. A lethally hit enemy body may continue player contact only when it is both explicitly contact-damaging and still execution-protected. Interceptor `cut-dash`, Striker `strike-dash`, and any future protected contact state retain authored damage and the normal body cooldown until their committed execution ends; dead non-executing bodies are rejected even if stale contact flags remain.
- Added an end-to-end post-lethal dash regression: kill during the dash, overlap the player, accept authored damage once, reject the repeated overlap during cooldown, reject stale contact after the state ends, then despawn and emit cleanup exactly once.
- Reworked threat-wave telemetry around successful materialization. `rolesSeen`, `lastWave`, `lastWave.materialized`, and `encounter:threat-wave` now report only roles that actually entered the enemy pool. Their cost, projectile cost, blocked-area cost, and high-damage warning count are recomputed from the materialized role definitions.
- Preserved pre-admission information only under explicit `selectedDiagnostics` and `rejectedDiagnostics`. The capacity-one regression now selects a cost-nine wave, materializes only Hunter, and reports actual cost one at every public/event materialized surface while retaining the rejected roles/cost solely in diagnostics.
- Removed every authoritative-world fallback from the natural enemy renderer acceptance. Role reachability and Warden/Lancer parity now depend only on stable renderer observations. The scenario directly requires nonzero rendered Warden wall radius, Warden gap radius, Lancer safe radius, Lancer preview count, and Lancer beam-node count, with zero rendered nodes outside the preview.
- Added `getAuthoritativeContactRadius` as the shared circular footprint contract. Collision and `enemyHazard` rendering both prefer positive `contactRadius`, otherwise `radius`, and ignore conflicting generic/axis scale values for circular hazards.
- Hardened rendered Lancer containment observations to use the actual rendered node footprint rather than a separate radius field.
- Added conflicting-field parity coverage for Warden wall nodes, Lancer beam nodes, Mine explosions, and Bulwark counter waves. Each case mutates `scale`, `scaleX`, `scaleY`, `radius`, and `contactRadius` independently and proves the rendered matrix and collision boundary use the same authoritative footprint.

### Verification
All Node/npm commands used Node 22.14.0 from the required runtime. Port 4173 remained untouched; browser validation used temporary Vite port 4174 and isolated headful Chrome 146.0.7680.80 on CDP 9358.

- Focused collision/director/renderer/world/enemy tests — PASS: 65/65.
- Final `npm run check` — PASS: 221/221 Node tests and production build.
- Focused natural enemy renderer-only acceptance — PASS: 1/1.
- Focused compact Standard/Abyss cap acceptance — PASS: 1/1.
- Full browser matrix — PASS: 31/31 in one final run.
- Breakpoint cleanup failure-path self-test — PASS: 1/1.
- `git diff --check` — PASS.

### Concerns
- Vite retains the inherited large-chunk warning; the final main bundle is 853.38 kB minified (237.05 kB gzip). Code splitting remains outside Task 9.
- Selected/rejected diagnostics intentionally remain in debug/event telemetry for admission analysis, but all unqualified wave fields are now strictly materialized values.
