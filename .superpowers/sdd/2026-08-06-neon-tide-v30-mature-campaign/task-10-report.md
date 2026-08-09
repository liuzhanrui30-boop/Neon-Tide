# Task 10 report — Automatic weapon build progression

## Status
DONE — strict SDD/TDD implementation and final verification complete.

## Commit
- `feat: add automatic weapon build progression` (this task commit)

## Delivered
- Added exactly 24 deeply immutable, localized, bounded upgrades in the planned distribution: 8 weapon, 6 phase, 5 Lance, and 5 utility. Validation rejects duplicate IDs, missing copy, unknown tags, unsafe stacking/effects, invalid starter compatibility, and any new active input.
- Added deterministic unique three-card offers, a separate boss-core reward subset, canonical build serialization, stack application, and finite capped derived stats. Pending offers and stacked builds are owned by `GameSession` and survive Standard checkpoint round trips exactly.
- Implemented all three automatic-weapon build families in authoritative gameplay:
  - Overload Chain changes hit propagation, chain damage/radius, pulse spread, and drone arc count.
  - Rift Penetration changes projectile traversal, piercing/splitting, weak-point weighting and damage, objective damage, and Tide Lance line behavior.
  - Tide Escort changes drone count, pickup attraction/value, movement support, repairs, and objective-proximity progress.
- Integrated derived build stats through bootstrap, player, weapon, collision, objective, entity-world, and legacy compatibility paths without adding an input action.
- Added accessible upgrade cards that expose behavior changes, current/new stack, tags, and compatible starter weapons. The selection flow retains modal focus behavior and returns focus to the game canvas.
- Added deterministic unit coverage for the catalog, validation, offers, boss-core subset, 10-choice build simulation, all three family effects, session authority, and exact checkpoint restoration.
- Added and registered a natural headful browser scenario that completes a real room, verifies deterministic accessible cards, selects through real UI input, and observes the resulting gameplay-stat changes.

## Verification
All Node/npm commands used the required Node 22.14.0 runtime:
`PATH=/Users/kanyun/Documents/zhanrui/threejs-neon-tide/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH`

Port 4173 was not touched. Browser validation used Vite on temporary port 43111 and isolated headful Chrome 146.0.7680.80 on CDP 9360.

- Final `npm run check` — PASS: 231/231 Node tests plus production build.
- Focused natural upgrade browser acceptance — PASS: 1/1.
- Full browser matrix — PASS: 32/32 in one final run.
- Breakpoint cleanup failure-path self-test — PASS: 1/1.
- `git diff --check` — PASS.

## Concerns
- Vite retains the inherited large-chunk warning; the final main bundle is 873.60 kB minified (244.14 kB gzip). Code splitting remains outside Task 10.
- Starter-weapon compatibility is fully represented and validated in the upgrade model/UI; broader campaign starter-selection routing remains outside this progression task.

## Fix round 1/5 — Authoritative upgrade effects

### Status
DONE — both Critical, all six Important, and the Minor review findings are fixed with deterministic unit and natural-browser regression evidence.

### Review findings closed
- **Critical — finite projectile traversal:** friendly projectiles now carry an explicit bounded distinct-target hit budget, remember up to the maximum supported traversal history across fixed steps, sort swept hits by along-segment distance then stable entity ID, and never re-hit one body. One pierce is exactly the primary hit plus one later hit. Arc follow-ups inherit dedupe history, upgraded radius, damage, weak-point, and objective multipliers.
- **Critical — one Tide Lance contract:** selection, rendering, circle collision, target cap, real legacy damage, objective damage, weak-point priority/damage, and audio all consume one cached `deriveTideLanceSpec`. `lancePierce` expands the same finite hit cap and `lancePropagation` creates bounded, deduplicated secondary arcs using the upgraded chain radius/damage.
- **Important — pending-offer authority:** canonical build validation recomputes the exact ordered three-card offer from seed/build/reward subset and rejects forged, reordered, maxed, stale, boss-subset, or starter-incompatible cards. Playing/start-room transitions reject unresolved offers. Standard checkpoints are written for both pending and selected offer states, and Continue routes a restored pending checkpoint back to the real upgrade dialog rather than attempting to skip it.
- **Important — all effect consumers:** every declared effect key is registered and validation rejects effects without a consumer. Drone arc budgets, chain propagation values, perfect-phase cadence across every real collision family, incremental Lance energy gain, room repair, escort repair, objective proximity, pickup attraction/value, starter projectile fields, and Tide Lance propagation now have production consumers. Misleading localized claims were tightened to match actual mechanics.
- **Important — starter compatibility:** weapon-specific cards now have meaningful starter subsets; canonical builds reject incompatible stacks; offers and choices filter by the selected starter; `setBuild` cannot switch starters after progression begins; and the weapon system fires only Pulse Cannon, Arc Drones, or Prism Missiles for the authoritative starter. Inactive drones are cleaned if the starter/count changes.
- **Important — allocation/cache authority:** canonical builds have stable identity, derived stats and Tide Lance specs are WeakMap-cached, `GameSession` owns one stable derived-stat object plus a build revision, and bootstrap/legacy/weapon fixed-step paths no longer clone/re-derive progression at 60 Hz. Selection, explicit build changes, starter selection, restore, new run, and reset invalidate the cache exactly once.
- **Important — browser acceptance:** three natural real-room/UI scenarios now prove Overload Arc chains, Rift Prism traversal, and Tide moving-objective acceleration. The Overload scenario reloads a real pending checkpoint, proves skip rejection, continues to the exact same accessible cards, selects through real UI, reloads again, and resumes the exact selected canonical build.
- **Important — ARIA:** upgrade card accessible names include localized behavior, current/new stack, tags, and the active compatible starter weapon. Delegated listeners and focus trapping remain single-owner; selection returns focus to the canvas and event queues report zero drops.
- **Minor — canonical reset schema:** initial, new-run, restored, and reset builds all expose the full immutable `{ ownedUpgrades, starterWeapon, upgradeStacks, offerSequence, pendingOffer }` schema.

### Additional audit hardening
- Added exhaustive catalog coverage proving every declared effect changes its canonical derived stat at every stack and stays inside its authored bounds.
- Added real-consumer coverage for all four perfect-phase collision families, direct player-hit cadence, objective proximity, escort repair, starter-lock bypass rejection, projectile ordering/dedupe, chain propagation, cached identity/invalidation, and public snapshot immutability.
- Updated inherited browser contracts to the authoritative single-starter model and the shared default Tide Lance hit cap, and stabilized long objective/anti-orbit acceptance by isolating route semantics from unrelated combat and eliminating waypoint stop gaps.

### Verification
All Node/npm commands used Node 22.14.0:
`PATH=/Users/kanyun/Documents/zhanrui/threejs-neon-tide/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH`

Port 4173 was never used. Final browser validation used temporary Vite port 44127 and a fresh isolated **headful** Chrome 146.0.7680.80 profile on CDP 9447 (not 9333).

- Focused modified Node suites — PASS: 92/92.
- Final `npm run check` — PASS: 250/250 Node tests plus production build.
- Required focused browser acceptance — PASS: 7/7 (Overload/checkpoint, Rift, Tide, weapon, objective, anti-orbit, enemy).
- Final full browser matrix — PASS: 34/34 in one run.
- Breakpoint cleanup failure-path self-test — PASS: 1/1.
- `git diff --check` — PASS.
- Production bundle — PASS: 884.24 kB minified / 247.10 kB gzip main JS.

### Concerns
- Vite retains the inherited large-chunk warning for the 884.24 kB main bundle; code splitting remains outside Task 10.
- The campaign still defaults to Pulse Cannon and exposes starter selection through session authority rather than a dedicated new starter-selection screen; Task 10 required compatible cards and authoritative starter behavior, not a new campaign input/menu.
