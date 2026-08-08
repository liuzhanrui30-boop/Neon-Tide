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
