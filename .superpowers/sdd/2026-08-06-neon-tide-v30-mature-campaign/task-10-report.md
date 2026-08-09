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

## Fix round 2/5 — Progression restore authority hardening

### Status
DONE — all three Important and all three Minor round-2 findings are fixed with authoritative Node and natural-browser regression evidence.

### Review findings closed
- **Important — selected checkpoint chapter parity:** authored campaign checkpoints now project the explicit next chapter from the authoritative room sequence, while compatibility campaign nodes preserve their explicit realm node. Natural room starts derive the same chapter instead of trusting stale completed-room input. A selected-checkpoint reload now proves the same next template, chapter, realm presentation, and threat budget as uninterrupted play.
- **Important — public build mutation bypass:** `setBuild()` is restricted to empty pre-progression menu/briefing starter configuration. It cannot run while playing, paused, upgrading, or at a chapter boundary; cannot clear a pending offer; and cannot grant any upgrade stack. Legacy upgrade selection now goes only through the pending-offer session authority.
- **Important — exact checkpoint validation:** persisted builds require the full exact five-field schema, exact pending-offer schema, exact sorted equality between `ownedUpgrades` and positive `upgradeStacks`, compatibility/max-stack validity, deterministic cards and progression-derived offer seed, boundary-complete room stats, and mutually possible selected-stack/offer-sequence/room counts. Forged schemas and impossible progress are rejected and cleared; valid pending and selected checkpoints still round-trip.
- **Minor — Arc history capacity:** arc propagation now carries seven dedupe IDs, so `chainCount: 6` means the primary plus six distinct follow-ups. A seven-target aligned regression proves stable order, one hit each, and no repeat.
- **Minor — cache external mutability:** Tide Lance identity caching is limited to frozen stat objects. Mutable callers are recomputed, weapon updates snapshot mutable inputs into frozen detached debug state, resets clear debug references, and production session stats retain stable frozen identity without per-step allocation.
- **Minor — Rift startup readiness:** the natural upgrade harness now waits for the authoritative API, session, player projection, encounter, weapon projection, and finite player coordinates before dereferencing Rift evidence; it no longer relies on sleep-only startup timing.

### Additional compatibility hardening
- Compatibility browser coverage selects Repair Swarm through a deterministic real boss offer instead of using the removed build-injection path.
- The Standard death/Continue regression now verifies that the selected Repair Swarm checkpoint authoritatively restores four hull rather than silently starting an empty build.
- The browser foundation checkpoint fixture was upgraded to the exact persisted build schema.

### Verification
All Node/npm commands used Node 22.14.0:
`PATH=/Users/kanyun/Documents/zhanrui/threejs-neon-tide/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH`

Port 4173 was never used. Browser validation used temporary Vite port 44219 and a fresh isolated headful Chrome 146.0.7680.80 profile on CDP 9459 (not 9333).

- Focused modified Node suites — PASS: 60/60 after the final regression additions.
- Final `npm run check` — PASS: 254/254 Node tests plus production build.
- Required focused browser acceptance — PASS: 7/7 (Overload selected/pending checkpoint parity, Rift, Tide, weapons, objectives, anti-orbit, enemies).
- Additional focused compatibility acceptance — PASS: desktop checkpoint/Continue and Repair Swarm/ARIA.
- Final full browser matrix — PASS: 34/34 in one run.
- Breakpoint cleanup failure-path self-test — PASS: 1/1.
- `git diff --check` — PASS.
- Production bundle — PASS: 886.06 kB minified / 247.64 kB gzip main JS.

### Concerns
- Vite retains the inherited large-chunk warning for the 886.06 kB main bundle; code splitting remains outside Task 10.
- One earlier full-matrix attempt hit the inherited boss-pause timing assertion by two fixed steps; the focused scenario immediately passed and the final clean full matrix passed 34/34.

## Fix round 3/5 — Safe v2 checkpoints and exact route provenance

### Status
DONE in `f8009dff5669c901a4f5299df871872236856efa` (`fix: migrate progression checkpoints safely`) — the round introduced version-2 route-bearing checkpoints, one-field legacy migration, exact authored/compatibility continuation, bounded validation, and regression coverage.

### Delivered
- Added the exact v2 checkpoint route schema `{ kind, roomIndex, chapterIndex, realmIndex, templateId }` and made session/runtime Continue consume that route rather than reconstructing a node from loose counters.
- Added strict migration for the historical one-field `{ ownedUpgrades }` build, including Repair Swarm hull preservation, atomic replacement retry, one-way/idempotent rewrite, and corrupt unknown/malformed clearing.
- Added exact authored and compatibility pending/selected continuation checks for template, chapter, realm, and threat budget, replacing the previous weak greater-than-or-equal chapter assertion.
- Added outer chapter/stat bounds and route/build/progression cross-field checks, plus headful legacy migration acceptance.

### Verification
All Node/npm commands used Node 22.14.0. Port 4173/9333 was not used. Final headful validation used isolated Vite `43874` and Chrome CDP `9441`.

- Full Node suite — PASS: 259/259.
- Production build — PASS.
- Focused authored, compatibility, and one-field Repair Swarm migration browser scenarios — PASS.
- Full headful browser matrix — PASS: 35/35.
- Breakpoint cleanup self-test — PASS: 1/1.
- `git diff --check` — PASS.

### Round-3 follow-up
Round 4 below corrects the review-discovered historical five-field v1 omission, chapter-three boss mapping, and deeper semantic/hull validation. The round-3 entry records what `f8009df` actually delivered rather than claiming those later corrections.

## Fix round 4/5 — Preserve every historical progression save

### Status
DONE — both valid historical v1 build schemas are preserved, compatibility chapter three resumes the real boss encounter, and migration/v2 validation now enforce historical semantic and hull invariants.

### Review findings closed
- **Both historical v1 schemas:** migration accepts the exact one-field `{ ownedUpgrades }` form and the immediate-predecessor exact five-field canonical build. Canonical selected and pending offers retain their complete build state and deterministic pending authority. Unknown, extended, malformed, stale, and impossible forms are still cleared.
- **Atomic and idempotent rewrite:** serialization completes before replacement, failed replacement leaves the original v1 value available for retry, and a successful second load observes v2 without re-migration.
- **Compatibility boss provenance:** chapters 0–2 migrate to their exact `v2.2-compatibility-chapter-N` nodes; chapter 3 migrates to `v2.2-boss-compatibility`. Continue marks the boss triggered, starts the boss encounter, materializes the real boss entity, and remains naturally completable to victory.
- **Semantic validation:** persisted progress must represent a completed boundary, contain at least one completed room, and cannot claim a chapter beyond completed progress. Authored routes remain seed/template exact; compatibility route/chapter/stats must agree; boss routes require chapter-three progress.
- **Hull/build consistency:** both migrated v1 and exact v2 saves require `hull <= maxHullForRunBuild(build, 3)`. Empty-build hull inflation is rejected while one-field and canonical Repair Swarm hull-four saves remain valid.
- **Natural browser migration:** the authored Overload flow now reloads immediate-predecessor pending and selected v1 canonical checkpoints; compatibility Continue migrates a real canonical pending checkpoint; dedicated one-field and chapter-three boss scenarios cover legacy continuation.

### Verification
All Node/npm commands used Node 22.14.0:
`PATH=/Users/kanyun/Documents/zhanrui/threejs-neon-tide/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH`

Port 4173/9333 was never used. Browser validation used fresh isolated headful Chrome 146.0.7680.80 with temporary Vite port `43881`, CDP `9461`, and a unique temporary profile.

- Focused v1 one-field/five-field selected+pending migration Node suites — PASS.
- Full Node suite — PASS: 262/262.
- Production build — PASS: 890.90 kB minified / 249.10 kB gzip main JS.
- Focused headful acceptance — PASS: one-field Repair Swarm migration, canonical authored pending+selected migration, canonical compatibility pending migration, chapter-three boss migration/completion, and authored/compatibility upgrade Continue.
- Final full headful browser matrix — PASS: 36/36.
- Breakpoint cleanup failure-path self-test — PASS: 1/1.
- `git diff --check` — PASS.

### Concerns
- Vite retains the inherited large-chunk warning; code splitting remains outside Task 10.
- Route provenance did not exist in v1. The migration therefore uses the predecessor app's generated chapter/room patterns: canonical saves matching the authored sequence resume authored content, while compatibility stage patterns and all one-field legacy saves resume compatibility nodes, with chapter three forced to the boss node.
