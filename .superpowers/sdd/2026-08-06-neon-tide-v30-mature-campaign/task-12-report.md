# Task 12 report — Abyss chapter and Abyss Maw vertical slice

## Status
DONE FOR REVIEW — the first complete campaign chapter has authored room pacing, a four-phase outcome-driven Boss, anti-orbit pressure that causes real collision damage, pooled attacks, collision-based weak-point destruction, deterministic cleanup, and Standard retry behavior. The full Node 22 deterministic suite and production build pass. Isolated headful coverage proves real-E firing after 31 seconds in Maw weak points, single ECS damage authority, exact visual/damage ray geometry, the legacy no-ECS fallback, the complete v3 weapons file, and the complete Abyss Maw browser tail through real weapon victory and cleanup.

## Commit
- `f7fe820 feat: add Abyss chapter and Maw boss`
- `8020e33 fix: harden Abyss Maw runtime contracts`
- `f7dd10b fix: close Abyss combat authority gaps`
- `867b006 fix: unify Tide Lance runtime authority`
- `fix: enforce single Tide Lance combat authority` (current amended review-fix commit)
- `fix: finalize Abyss combat contracts` (round 5 final commit)

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

### Review round 4 closeout
- Bulwark armor breaking is now a state gate only. `EnemySystem` changes `armored`/`weakPoint` and counter state without mutating HP; `CollisionSystem` is the only Tide Lance HP writer. The real integrated result is one damage record and one delta from `20` to `16.8`, never the former `20 → 18 → 14.8` double write.
- Mirrored legacy enemy roles are normalized to ECS role IDs. Natural Bulwark/Elite mirrors retain ECS-owned armor and counter state across compatibility sync frames instead of having that state overwritten by the legacy visual actor.
- One ECS Tide Lance `weaponHit` now produces one aggregated `laserHit` cue through `createLaserAudioEvents.onHits`. Presentation no longer emits a duplicate generic cue and uses the dedicated `光矛贯穿 ×N` feedback instead of `AUTO ×N`.
- The former manual mirror regression no longer forces laser-active state, calls the legacy resolver, manually spawns a projectile, or directly invokes collision. Real keyboard `E` input drives charge, WeaponSystem spawn, CollisionSystem damage, audio, feedback, and legacy HP mirroring for both an ordinary natural formation target and a natural Bulwark-role target.
- The broader Maw tail failure was identified as a real `hullBreach` after the organs were destroyed and the Boss had entered `enraged`; Standard correctly returned to `briefing`. The browser route now keeps using real keyboard movement and dash evasion, prefers achievable survival/damage upgrades, and uses only bounded legal session repairs at the two long combat-phase boundaries. It does not add long invulnerability, skip the Boss, clear Boss ownership, or forge victory.

### Inherited regression maintenance
- Restored the menu's explicit “潮汐光矛 / 坚持 100 秒” briefing language.
- Repacked the phone briefing into two columns and moved the laser control into the bottom control cluster so the 390×844 layout has no overlap.
- Updated stale legacy browser expectations to match the already-present accessible mode radio controls and Standard checkpoint return behavior; the focus trap continues to contain both radios and the primary action.

## TDD evidence
- Red phase: the focused Abyss/Boss tests initially failed with missing chapter, Boss content, and Boss system modules.
- Review red phase: the legal 60 Hz outer orbit produced counter telemetry but zero collision damage; Tide Lance forgot targets beyond seven slots; and its visible beam did not consume a WeaponSystem-owned aim projection.
- Final review red phase: managed Maw play after 31 seconds was rejected by the legacy stage-end guard; mirrored legacy targets could be damaged before CollisionSystem applied the same shot; and the visible beam started one player radius beyond the ECS ray.
- Review round 4 red phase: Bulwark armor break still wrote HP before CollisionSystem, Tide Lance hit feedback played `laserHit` twice and displayed `AUTO ×N`, the browser mirror test bypassed real input and WeaponSystem, and the complete Maw tail naturally died after entering `enraged`.
- Green phase: implemented immutable chapter beats, real Director consumption, outcome-gated Boss phases, attacks, collision records, cleanup, retry behavior, and browser authority until the focused suite passed.
- Review green phase: real counter gates reduce hull through BossSystem + CollisionSystem, 16 fixed hit-history slots retain every distinct target across frames, and one authoritative Boss-aware aim drives both visual and damage rays.
- Final review green phase: one shared availability contract accepts managed weak-point fire after 31 seconds, an EntityWorld bridge selects ECS as the sole damage authority, all 16 hit slots are exercised, and the visible/damage rays share exact center, direction, and endpoint data.
- Review round 4 green phase: the real `E → charge → WeaponSystem → CollisionSystem → legacy mirror` path applies exactly one Bulwark HP delta and one damage record, emits one Tide Lance hit cue with dedicated copy, and the complete headful Maw route reaches upgrade after real organ/core weapon damage and deterministic cleanup.
- Refactor phase: kept `ObjectiveSystem` as a discriminator/consumer rather than a second Boss writer, gated Maw by campaign provenance, preserved compatibility routes, bounded all Boss entities, and made cleanup generation-safe and idempotent.

## Verification
All final deterministic commands used Node `22.14.0`.

- `npm test` — PASS: `306/306`.
- `npm run build` — PASS:
  - minified production build
  - unminified production build
  - entry-size assertion (`31,156` bytes, limit `500,000`)
- `node --check` for every changed source/browser module — PASS.
- `git diff --check` — PASS.
- Browser acceptance used temporary Vite `4174` and isolated **headful** Chrome `146` on CDP `9337`. The required short Maw probe reached `weakPoints` through real keyboard movement, set managed elapsed time above `31s`, and accepted a real `E` press with a new `lanceShots` count. Its visible origin, direction, and endpoint matched WeaponSystem's damage ray within `1e-6` — PASS (`37.884s`).
- The full v3 weapons file ran under a `60s` hard timeout — PASS `2/2`: automatic combat (`4.314s`) and the genuine real-E ordinary/Bulwark mirror authority scenario (`2.046s`). The latter asserted one HP delta, one Tide Lance damage record, one `laserHit`, dedicated feedback copy, mirror equality, and the expected armor/weak-point transition.
- The full v3 Abyss file ran under a `150s` hard timeout — PASS `3/3`: managed post-31-second real Lance (`37.884s`), fixed-orbit rejection plus varied-route full Maw weapon victory (`53.550s`), and Standard death reconstruction (`1.076s`). The victory tail destroyed all three organs and the core through real WeaponSystem/CollisionSystem damage, reached `upgrade`, removed every Boss part/owned entity, and reported clean cleanup with zero dropped events.
- Inherited no-ECS compatibility probes remained green: pickup-charged Lance (`0.703s`), damage/execution contracts (`0.533s`), and natural lifecycle plus legacy stage boundaries (`2.344s`).
- Temporary `4174`/`9337` processes were stopped and both ports were verified closed. Existing `127.0.0.1:4173` and CDP `9333` were not touched.

### Final production chunks
- Main entry: `15.38 kB` minified / `5.76 kB` gzip.
- Gameplay core: `209.21 kB` / `66.65 kB` gzip.
- Legacy runtime: `175.40 kB` / `55.74 kB` gzip.
- Render core: `20.47 kB` / `7.39 kB` gzip.
- Three.js vendor: `525.56 kB` / `132.54 kB` gzip.
- Deferred non-Abyss chapter chunks: `0.28–0.29 kB` / `0.22 kB` gzip.
- Unminified main entry: `31,156` bytes, below the enforced `500,000`-byte ceiling.

## Remaining concern
- No unresolved Task 12 functional or acceptance concern remains. Vite's existing size warning applies only to the separately cached Three.js vendor chunk; the application entry remains small and the three later chapters remain lazy. Task 13 should populate the existing Data City boundary rather than moving chapter content into the eager entry.

## Review round 5 final closeout

### RED
- Preserved the interrupted implementer's uncommitted RED coverage instead of reverting it. The focused run failed because CollisionSystem produced no Tide Lance or dash damage record for an armored Bulwark, while EnemySystem still broke armor and scheduled a counter from its own independent `18`-unit ray/extra-width geometry.
- The distance-`10` regression demonstrated the authority bug directly: the real default `7.2` Tide Lance produced zero collision records, but the old EnemySystem projection still removed armor and entered a counter.
- The dash regression demonstrated the missing authored outcome: a real invulnerable player dash swept through a Bulwark but produced no `phase-dash` record and no one-point HP delta.
- The complete Abyss acceptance still contained two direct `session.upgradeHullCapacity(maxHull, { repair: maxHull })` full heals. Removing them first exposed an inertial keyboard-route miss during the natural Maw tail, matching the reported long-fight instability without weakening Boss attacks.

### GREEN
- CollisionSystem is now the only Bulwark combat outcome writer. A real Tide Lance sweep or player dash sweep writes the single HP delta, records `armorBreak`, `armorBreakKind`, and a bounded uint attack token, and flips armor/weak-point state. EnemySystem contains no Tide Lance ray or dash overlap calculation; it only consumes a fresh collision-authored token to begin the authored fair counter warning.
- Default Tide Lance reach is exact: the near target changes `20 → 16.8` with exactly one record, while a Bulwark at distance `10` remains `20`, armored, without a token, warning, or counter. A real dash overlap changes `20 → 19`; the same dash token cannot apply twice, and a missed target is unchanged.
- Tide Lance presentation now uses a fixed 16-source `Float64Array` ring. The same generation-safe projectile source across two summaries can add later damage records but produces exactly one `laserHit`, one dedicated `光矛贯穿` feedback, and no `AUTO` fallback. Reset clears the ring; no unbounded `Set` or dedupe allocation was added to the hot path.
- The Bulwark legacy mirror regression now waits through a later compatibility sync frame and proves `state`, `counterToken`, and `executingTelegraph` remain ECS-owned rather than being overwritten.
- Tide Lance damage/audio/feedback/record/text telemetry is exposed only by a DEV `?campaign-test` or `?weapon-test` page. Production snapshots omit all five fields even when both query parameters are supplied; no repair authority was added.
- The Abyss bot uses only real keyboard movement, real dash input, real Tide Lance input, and offers that were actually present in the deterministic three-card upgrade choices. Legacy non-Boss spawn timers remain stopped, while Maw warnings, attacks, minions, projectiles, collision damage, phase gates, and cleanup remain live.
- Both direct full heals were deleted. The route driver now corrects normal inertial overshoot with further real key holds, and the natural victory asserts damage taken increases after weak-point exposure while hull remains above zero at the upgrade screen.

### Verification commands and real output
All commands used Node `22.14.0`.

- `npm test` — PASS `308/308` in `5.516s`.
- `npm run build` — PASS. Minified production chunks included main `15.42 kB` (`5.78 kB` gzip), gameplay core `209.94 kB` (`66.92 kB` gzip), runtime legacy `176.35 kB` (`55.98 kB` gzip), render core `20.47 kB` (`7.39 kB` gzip), and cached Three.js vendor `525.56 kB` (`132.54 kB` gzip). The unminified entry was `31,259` bytes, below the `500,000`-byte limit.
- `node --check` for every changed JS/MJS module — PASS.
- `git diff --check` — PASS.
- Isolated headful Chrome `146.0.7680.80`, temporary Vite `4174`, CDP `9337`, full `v3-weapons` under a `60s` hard timeout — PASS `2/2`: automatic combat `5.166s`; real Tide Lance/Bulwark authority, two-summary presentation dedupe, and later sync preservation `2.049s`.
- Fresh isolated headful Chrome run 1, full `v3-abyss` under a `150s` hard timeout — PASS `3/3`: post-31-second real Lance `38.342s`; orbit rejection plus natural no-repair weapon victory `54.203s`; Standard reconstruction `1.017s`.
- A second fresh isolated headful Chrome run 2, full `v3-abyss` under a separate `150s` hard timeout — PASS `3/3`: `39.009s`, `54.084s`, and `1.043s`.
- Production preview `4175` with `?campaign-test=1&weapon-test=1`, headful production probe — PASS `1/1`: no `campaignTest`, `bossTest`, or `repairHull` authority; no Tide Lance test telemetry fields; direct campaign settlement still rejected.
- Temporary Vite `4174`/preview `4175` and CDP `9337` were stopped and verified closed. The existing `4173` service was not touched; CDP `9333` was not used.

### Remaining concerns after round 5
- No unresolved Task 12 functional, browser-stability, authority, or production-isolation concern remains. The existing Vite size warning is still limited to the separately cached Three.js vendor chunk.
