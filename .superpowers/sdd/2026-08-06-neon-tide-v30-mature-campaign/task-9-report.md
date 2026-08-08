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
