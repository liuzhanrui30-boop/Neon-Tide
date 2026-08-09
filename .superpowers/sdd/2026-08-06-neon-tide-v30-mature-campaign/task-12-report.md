# Task 12 report — Abyss chapter and Abyss Maw vertical slice

## Status
DONE — the first complete campaign chapter now has authored room pacing, a four-phase outcome-driven Boss, anti-orbit pressure, real pooled attacks, collision-based weak-point destruction, deterministic cleanup, Standard retry behavior, and browser acceptance.

## Commit
- `feat: add Abyss chapter and Maw boss` (this task's single commit)

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
- Added a development-only `?boss-test` browser authority for deterministic movement and collision acceptance. Production exposes no `bossTest` capability.

### Inherited regression maintenance
- Restored the menu's explicit “潮汐光矛 / 坚持 100 秒” briefing language.
- Repacked the phone briefing into two columns and moved the laser control into the bottom control cluster so the 390×844 layout has no overlap.
- Updated stale legacy browser expectations to match the already-present accessible mode radio controls and Standard checkpoint return behavior; the focus trap continues to contain both radios and the primary action.

## TDD evidence
- Red phase: the focused Abyss/Boss tests initially failed with missing chapter, Boss content, and Boss system modules.
- Green phase: implemented immutable chapter beats, real Director consumption, outcome-gated Boss phases, attacks, collision records, cleanup, retry behavior, and browser authority until the focused suite passed.
- Refactor phase: kept `ObjectiveSystem` as a discriminator/consumer rather than a second Boss writer, gated Maw by campaign provenance, preserved compatibility routes, bounded all Boss entities, and made cleanup generation-safe and idempotent.

## Verification
All commands used Node `22.14.0`.

- Final `npm run check` — PASS:
  - `291/291` Node tests
  - minified production build
  - unminified production build and entry-size assertion
- Focused gameplay/campaign/objective/collision suite — PASS: `146/146`.
- Focused Task 12 suite — PASS: `11/11`.
- New headful browser acceptance — PASS: `2/2`:
  - fixed orbit rejected, visible counter emitted, varied route accepted, organs/core destroyed through real collision, natural campaign settlement, zero Boss-owned entities after cleanup
  - Standard death at Maw reconstructs the clean Abyss chapter entry with no checkpoint
- Browser regression coverage:
  - shared isolated-Chrome run passed scenarios `1–28/39`
  - after correcting three stale inherited assertions, scenarios `29–39` all passed in focused runs
  - all 39 registered scenarios therefore have current-code passing coverage; no final monolithic rerun is claimed
- Breakpoint cleanup failure-path self-test — PASS: `1/1`.
- Production preview probe — PASS: `1/1`; stable split chunks load, campaign settlement stays private, and `campaignTest`/`bossTest` are absent.
- `git diff --check` — PASS.
- Existing live game on `127.0.0.1:4173` and its Chrome/CDP session were not touched. Verification used temporary Vite `44132`, preview `44133`, and isolated Chrome CDP `9452`.

### Final production chunks
- Main entry: `15.39 kB` minified / `5.76 kB` gzip.
- Gameplay core: `200.19 kB` / `63.72 kB` gzip.
- Legacy runtime: `174.90 kB` / `55.53 kB` gzip.
- Render core: `19.24 kB` / `7.06 kB` gzip.
- Three.js vendor: `525.56 kB` / `132.54 kB` gzip.
- Deferred non-Abyss chapter chunks: `0.28–0.29 kB` / `0.22 kB` gzip.
- Unminified main entry: `31,245` bytes, below the enforced `500,000`-byte ceiling.

## Remaining concern
- Vite's existing size warning still applies only to the separately cached Three.js vendor chunk. The application entry remains small and the three later chapters remain lazy. Task 13 should populate the existing Data City boundary rather than moving chapter content into the eager entry.
