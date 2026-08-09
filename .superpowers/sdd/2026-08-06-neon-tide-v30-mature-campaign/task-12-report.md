# Task 12 report — Abyss chapter and Abyss Maw vertical slice

## Status
DONE FOR REVIEW — the first complete campaign chapter has authored room pacing, a four-phase outcome-driven Boss, anti-orbit pressure that causes real collision damage, pooled attacks, collision-based weak-point destruction, deterministic cleanup, and Standard retry behavior. The full Node 22 deterministic suite and production build pass. Isolated headful probes now prove real-E firing after 31 seconds in Maw weak points, single ECS damage authority, exact visual/damage ray geometry, and the legacy no-ECS fallback. No complete end-to-end Boss victory browser PASS is claimed.

## Commit
- `f7fe820 feat: add Abyss chapter and Maw boss`
- `8020e33 fix: harden Abyss Maw runtime contracts`
- `f7dd10b fix: close Abyss combat authority gaps`
- `fix: unify Tide Lance runtime authority` (current review-fix commit)

## Delivered

### Authored Abyss progression
- Added a deeply immutable three-room Abyss definition:
  1. tutorial purge (`58s`)
  2. moving sanctum (`62s`)
  3. anchor grotto (`65s`)
  4. Abyss Maw Boss (`100s`)
- The first 90 seconds now have an explicit teaching sequence:
  - Hunter at `2s`
  - Swarm at `14s`
  - first route change at `29s`
  - Interceptor at `36s`
  - second-room route change at `58s` absolute
  - Mine at `66s` absolute
  - another route change at `78s` absolute
- Generic waves cannot introduce an enemy role before its authored beat. Future introduction slots are reserved against each room's active cap.
- The first two rooms use a maximum of two simultaneous high-damage warnings; inherited roles carry into later rooms.
- Moving/anchor objectives use their real shift authority. The purge room materializes non-damaging pooled current/gate geometry so its route change is visible without creating a second objective writer.
- `src/content/realms.js` now consumes the Abyss chapter definition instead of duplicating its route, durations, and Boss identity.

### Abyss Maw Boss
- Added a dedicated `BossSystem` with one authoritative mutable objective projection and four ordered phases:
  - `hunt`: stability is removed only by varied route breaks or Tide Lance hits; waiting alone cannot advance.
  - `suction`: a real external current pulls both the `EntityWorld` player and the legacy movement runtime; route crossings are required.
  - `weakPoints`: three moving organs become exposed only inside the authored radius and are real auto-target/collision priorities.
  - `enraged`: the arena center shifts again and the core becomes the final health gate.
- Added four attack families:
  - suction currents
  - tentacle fan with two authored safe gaps
  - tracking jelly pressure with capped homing bolts
  - a telegraphed closing bite zone
- Added normalized elliptical anti-orbit detection. Repeated outer-circle movement triggers a visible counter pattern and cannot expose the organs; a varied center-crossing route can progress.
- Boss body, organs, warnings, currents, minions, projectiles, and hazards use existing fixed `EntityWorld` pools and generation-safe IDs.
- The stress probe observed a maximum of `41` live Boss-owned entities; the regression budget is asserted at `<=48`.
- Cleanup is idempotent and removes every Boss-owned part/current/minion/projectile/warning/hazard, clears the music layer, emits objective cleanup, and invalidates stale entity handles.

### Campaign/session/runtime integration
- Maw is activated only for the authoritative campaign node where `chapterId === "abyss"`, node kind is Boss, and Boss id is `abyss-maw`; historical authored/compatibility Boss rooms retain their existing behavior.
- Collision damage records are forwarded into the Boss authority, so organ/core victories use the real collision system rather than direct HP mutation.
- Standard death in chapter zero, where no legal persistent chapter-entry checkpoint exists yet, reconstructs the exact chapter-entry state: selected starter retained, no chapter-earned offer/upgrades, route index zero, clean stats, and no fake midpoint save.
- Existing later Standard checkpoints still restore normally; Abyss full-restart semantics are unchanged.
- Old encounter directors are cleaned before session restore/start/reset so Boss-owned entities and presentation layers cannot survive a retry.
- Removed the former `?boss-test` debug authority entirely. Browser coverage now drives the ship with real keyboard events, uses the real movement/physics path, and fires the real Tide Lance input; production and development expose no `bossTest` capability.

### Review hardening
- Route breaks now require natural 60 Hz movement from an armed outer radius through the inner radius. Teleport-sized samples reset progress, and a legal fixed orbit still triggers active damaging counters without advancing the Boss.
- The anti-orbit counter now predicts the player's real velocity and supplements it with forward ellipse gates. Its preview and active oriented boxes are identical, retain a readable inward/reversal escape contract, and enter the normal collision pipeline instead of merely incrementing telemetry.
- Boss warnings, rendering, and collision share the same oriented-box dimensions and rotation for tentacle, bite, and suction-current geometry.
- Tide Lance is a real swept `friendlyProjectile` with bounded EntityWorld damage and the same authoritative reach, width, and hit budget as selection; no browser-only kill bullets remain.
- Tide Lance distinct-hit memory is a fixed preallocated 16-target schema shared by EntityWorld and CollisionSystem. A two-frame regression consumes all 16 distinct slots, proves the beam tail cannot re-hit them, and leaves the seventeenth target untouched.
- WeaponSystem is the sole Tide Lance aim authority. The exact selected direction and target set drive both the ECS damage ray and the legacy visible beam, including Boss organs; the legacy runtime no longer performs a competing auto-target or retarget pass.
- Managed campaign availability and `attemptLaser` now consume the same shared predicate. Legacy `STAGES[].end` still protects compatibility transitions, while managed objectives ignore that obsolete 30-second boundary and can fire normally after 31 seconds.
- Once an EntityWorld combat bridge exists, CollisionSystem is the only Tide Lance HP writer. The legacy beam consumes collision summaries for mirrored HP, hit stats, audio, and feedback; it directly damages targets only in the explicit no-ECS fallback path.
- WeaponSystem creates one normalized center-to-length Tide Lance ray. Projectile sweep origin/end and the visible translated-plane origin/end now project that exact ray with direction, start, and end parity.
- Boss-owned enemies, hazards, warnings, projectiles, and parts have explicit ownership sets and a single Boss writer. Generic enemy/projectile systems skip them, while cleanup and hot snapshots avoid pool-wide ownership scans.
- Authored beat timing now scales with `durationScale`; failed Boss part spawns retry and fail closed; reported spawn/attack counts reflect successful allocations only.
- Standard/Abyss recovery, variant, telegraph-floor, jelly, suction, and orbit-counter behavior is contract-driven. Public Boss objectives are deeply frozen detached snapshots.

### Inherited regression maintenance
- Restored the menu's explicit “潮汐光矛 / 坚持 100 秒” briefing language.
- Repacked the phone briefing into two columns and moved the laser control into the bottom control cluster so the 390×844 layout has no overlap.
- Updated stale legacy browser expectations to match the already-present accessible mode radio controls and Standard checkpoint return behavior; the focus trap continues to contain both radios and the primary action.

## TDD evidence
- Red phase: the focused Abyss/Boss tests initially failed with missing chapter, Boss content, and Boss system modules.
- Review red phase: the legal 60 Hz outer orbit produced counter telemetry but zero collision damage; Tide Lance forgot targets beyond seven slots; and its visible beam did not consume a WeaponSystem-owned aim projection.
- Final review red phase: managed Maw play after 31 seconds was rejected by the legacy stage-end guard; mirrored legacy targets could be damaged before CollisionSystem applied the same shot; and the visible beam started one player radius beyond the ECS ray.
- Green phase: implemented immutable chapter beats, real Director consumption, outcome-gated Boss phases, attacks, collision records, cleanup, retry behavior, and browser authority until the focused suite passed.
- Review green phase: real counter gates reduce hull through BossSystem + CollisionSystem, 16 fixed hit-history slots retain every distinct target across frames, and one authoritative Boss-aware aim drives both visual and damage rays.
- Final review green phase: one shared availability contract accepts managed weak-point fire after 31 seconds, an EntityWorld bridge selects ECS as the sole damage authority, all 16 hit slots are exercised, and the visible/damage rays share exact center, direction, and endpoint data.
- Refactor phase: kept `ObjectiveSystem` as a discriminator/consumer rather than a second Boss writer, gated Maw by campaign provenance, preserved compatibility routes, bounded all Boss entities, and made cleanup generation-safe and idempotent.

## Verification
All final deterministic commands used Node `22.14.0`.

- `npm test` — PASS: `305/305`.
- `npm run build` — PASS:
  - minified production build
  - unminified production build
  - entry-size assertion (`31,156` bytes, limit `500,000`)
- `node --check` for every changed source/browser module — PASS.
- `git diff --check` — PASS.
- Browser acceptance used temporary Vite `4174` and isolated **headful** Chrome `146` on CDP `9337`. The required short Maw probe reached `weakPoints` through real keyboard movement, set managed elapsed time above `31s`, and accepted a real `E` press with a new `lanceShots` count. Its visible origin, direction, and endpoint matched WeaponSystem's damage ray within `1e-6` — PASS (`38.635s`).
- The natural compatibility mirror probe preserved a naturally spawned legacy enemy, proved legacy direct resolution returned zero under ECS authority, applied exactly one CollisionSystem damage record, and produced no second-frame re-hit — PASS (`1.248s`).
- Inherited no-ECS compatibility probes remained green: pickup-charged Lance (`0.703s`), damage/execution contracts (`0.533s`), and natural lifecycle plus legacy stage boundaries (`2.344s`).
- A broader v3 weapon scenario was attempted after these passes and stopped at debugger lexical visibility for `applyAuthoritativeTideLanceAim`, not a gameplay assertion. The method was then retained in the same debugger-visible integration scope, but that broad scenario was not rerun per stop instruction. No complete browser-matrix PASS is claimed.
- Temporary `4174`/`9337` processes and stale task-owned PIDs `47704`/`47707` were stopped and verified absent. Existing `127.0.0.1:4173` and CDP `9333` were not touched.

### Final production chunks
- Main entry: `15.38 kB` minified / `5.76 kB` gzip.
- Gameplay core: `209.25 kB` / `66.68 kB` gzip.
- Legacy runtime: `174.12 kB` / `55.37 kB` gzip.
- Render core: `20.47 kB` / `7.39 kB` gzip.
- Three.js vendor: `525.56 kB` / `132.54 kB` gzip.
- Deferred non-Abyss chapter chunks: `0.28–0.29 kB` / `0.22 kB` gzip.
- Unminified main entry: `31,156` bytes, below the enforced `500,000`-byte ceiling.

## Remaining concern
- The complete browser matrix still needs an independent rerun, including the final debugger-visibility-only v3 weapons change and the full Maw victory tail. Vite's existing size warning applies only to the separately cached Three.js vendor chunk; the application entry remains small and the three later chapters remain lazy. Task 13 should populate the existing Data City boundary rather than moving chapter content into the eager entry.
