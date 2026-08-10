# Task 13 report — Data City and Protocol Zero

## Final status

**ITEM 9 CLOSED; ITEM 8 REMAINS OPEN. TASK 13 BROWSER ACCEPTANCE IS NOT COMPLETE.**

The deterministic current-player→truthful-cell temporal corridor contract, project Node 22 suite, production build, syntax checks, and round-2 production cold probe are green. Round 3 removed the real data-lane browser-helper race, but the separately bounded Standard and Abyss campaign scenarios still failed before Protocol Zero. No Standard/Abyss Boss victory or cleanup is claimed.

## Delivered implementation

- Data City retains its authored introduce/develop/test rooms, explicit non-damaging data-lane contract, objective route mutations, lazy chapter loading, and production authority isolation.
- Protocol Zero retains real firewall, traffic-grid, clone-node, and kernel outcomes; non-color Standard/Abyss evidence; bounded pooled presentation; a 48-entity ownership ceiling; and idempotent cleanup.
- Item 9's traffic contract starts at the real current player position and ends at the truthful cell. Its published waypoints and clearance remain fixed across warning→active frames, and every traffic attack is rejected if it intersects the committed corridor.

## Round 1 history

- Deterministic Data City/Protocol behavior, build, and syntax checks were green.
- The final Standard browser path naturally cleared the three Data City rooms and firewall, then failed during traffic traversal with `dash movement interrupted in briefing`.
- Abyss and the production cold probe were not run after that Standard failure.

## Round 2 history

- The earlier arbitrary bottom→top single-frame grid proof was replaced with the current-player→truthful-cell temporal corridor proof.
- Deterministic coverage exercised 12 seeds × 4 truthful-cell rounds × all three traffic variants/timings plus a localized synthetic corridor seal.
- Project Node 22 passed `321/321`; focused Data City/Protocol passed `26/26`; build, syntax, and diff checks passed.
- The production cold-checkpoint browser batch passed `2/2`, proving release authority isolation and Data City lazy checkpoint loading. It was not rerun in round 3 because no related production code changed.
- The final Standard/Abyss browser batch stopped in `measureDataLaneRecovery`: `driveTo` could return at `tolerance * 2.4`, while the next assertion required `|y| <= 0.24`. Abyss was not reached.

## Round 3 browser-helper fix

- Lane geometry now comes from the public authored `objective.dataLane.laneCenter` and `laneHalfWidth`; the browser no longer assumes center `0` or uses the old widened `driveTo` early return.
- Baseline and lane positions use real keyboard-only axial correction with eight consecutive settled animation frames.
- The lane sample reserves a verified active-window budget, brackets consecutive public-position confirmation with lexical environment snapshots, and rejects any recovery sample that leaves the authored lane or active environment.
- Pause evidence is sampled only after the session is confirmed paused. Both dash charge and active environment elapsed/phase must remain exactly frozen.
- Recovery timing subtracts the measured pause duration and still requires the authored `0.65` recovery rate to be at least `1.32×` slower than baseline.
- A focused pure helper test covers derived center, half-width, inside tolerance, outside target, confirmation budget, and invalid authored geometry.

## Round 3 browser results

All runs used project Node `v22.14.0`, Chrome `146.0.7680.80`, Vite `4174`, CDP `9360`, and an independent 150-second hard process timeout. The first four prerequisite nodes used the disclosed campaign-test settlement hook only. Data City rooms were not skipped; movement, firewall, traffic, clone, kernel, automatic weapon, and Tide Lance paths remained real-input/resource paths. No hull/player/objective/phase/HP/energy writes or healing/invulnerability were added.

### Standard — FAIL

- After the helper fix, the lane measurement passed and the run naturally completed Escort and Storm.
- The final `duration-scale=0.15` Standard run failed in Dual Crisis with one of two crises complete: `progress=1/2`, `hull=3.65`, player `(-0.1018, 3.3172)`, then restored to briefing.
- One disclosed targeted diagnostic changed only the browser duration scale to `0.25`; it also restored to briefing during Dual Crisis. That unproven configuration change was reverted.
- Protocol Zero was not entered, so firewall/traffic/clone/kernel victory and cleanup are not claimed.

### Abyss — FAIL

- The separate Abyss run failed after the four prerequisite settlements while waiting to enter `data-city:escort-uplink`; the page returned to a non-matching campaign state before the first natural Data City room assertion.
- Protocol Zero was not entered, so Abyss shape/rhythm, traffic, clone, kernel victory, and cleanup are not claimed.

## Final verification

Project runtime: `/Users/kanyun/Documents/zhanrui/threejs-neon-tide/.runtime/node-v22.14.0-darwin-arm64/bin/node` (`v22.14.0`).

- Focused browser-helper/static check: `node --check tests/browser/v3-data-city.mjs` plus helper/Data City/player tests — PASS `25/25` (`1653.84625ms`).
- Final helper unit check after browser diagnostics — PASS `2/2` (`31.967084ms`).
- Full deterministic suite: `node --test` — PASS `323/323` (`5396.047708ms`).
- Production build and output assertion — PASS.
  - Data City lazy chunk: `4.80 kB` minified / `1.87 kB` gzip; `6.93 kB` unminified.
  - Main entry: `15.63 kB` minified / `5.85 kB` gzip; `31,661` bytes unminified.
  - Gameplay core: `235.01 kB` minified / `74.58 kB` gzip; `466.49 kB` unminified.
  - Existing warning: Three.js vendor chunk `525.56 kB` minified.
- Changed-file syntax and `git diff --check` — PASS.
- Round-2 production cold probe — PASS `2/2`; not rerun because round 3 changed browser tests/report only.

## Process state

Temporary Vite `4174` and Chrome CDP `9360` were stopped. `4175` and `9333` were not used. Existing `4173` (`Python`, PID `11284`) was not touched.

## Round 4 — fresh implementer diagnosis and bounded repair

**Status: ITEM 8 REMAINS OPEN. No Data City browser Boss victory or cleanup is claimed in this round.**

### Root causes found and repaired deterministically

1. **Compressed Standard Dual Crisis was physically inconsistent.** The `campaign-test=1&duration-scale=0.15` contract reduced Data City's 72-second deadline to 10.8 seconds and reduced the two real hold targets to 9.072 seconds total, but left the opposite-quadrant travel geometry at live scale. The previous deterministic test placed the player directly inside each target, so it could not detect that real movement plus two holds could exceed the compressed deadline. This explains the earlier `progress=1/2` timeout/reset while hull was still approximately 3.65; the session restored the Standard chapter-entry checkpoint after objective timeout.

   Repair: `tuneCampaignObjectiveTemplate()` now publishes `pacingGeometryScale` for compressed dual-crisis verification only (minimum `0.35`, exactly `1` for the live campaign). Objective construction and the authored crosslink beat scale both crisis centers and radii together, preserving opposite quadrants and non-overlap while leaving a real keyboard travel budget. The live 18–25 minute campaign uses `durationScale=1`, so its authored positions/radii remain unchanged.

2. **Abyss entered a different first Data City objective than the browser contract.** Generic Abyss shuffling also shuffled Data City's deliberate introduce → develop → test room order. After four disclosed prerequisite settlements, the browser waited for `data-city:escort-uplink`, but the route could instead begin with Storm or Dual Crisis. This was a campaign route/content-order defect, not a legitimate Data City lazy-load wait.

   Repair: Data City declares `preserveObjectiveOrder: true`; Abyss still varies pressure, Boss variants, and room order for chapters without an authored-order requirement. A deterministic session now settles the four Abyss prerequisites, loads Data City lazily, and starts the real `data-city:escort-uplink` escort room.

3. **Failure diagnostics were too shallow.** The browser follower now retains the terminal reason, elapsed/deadline, both crisis positions/charges/radii/escalation, crosslink, current public input target, player position, route, and hull. The prerequisite helper also requires the public Data City escort room to be active immediately after the chapter-entry upgrade.

### Added deterministic coverage

- `compressed Data City dual crisis reserves a real keyboard transit budget without changing the live contract` simulates conservative `3.75u/s` frame-by-frame movement with the real objective update path and two sequential charges. It proves completion before the compressed deadline, separate target cells, opposite quadrants, and no escalation; it also asserts live geometry scale remains exactly `1`.
- `Abyss preserves Data City’s authored teach order through the lazy chapter handoff` proves four legitimate prerequisite settlements reach route index 4, then starts the loaded escort room without route mutation or objective completion bypass.

### Round 4 validation

All commands used project Node `v22.14.0`.

```text
node --test tests/campaign-natural-completion.test.mjs tests/campaign.test.mjs tests/data-city-chapter.test.mjs
27/27 PASS

npm test
325/325 PASS

npm run build
PASS (existing vendor-three size warning only; lazy Data City chunk retained)

node --check src/content/realms.js src/game/campaign.js src/game/campaign-pacing.js src/systems/objective-system.js tests/browser/v3-data-city.mjs tests/campaign-natural-completion.test.mjs tests/campaign.test.mjs
git diff --check
PASS
```

### Browser acceptance result

A single bounded final Standard browser attempt was made after the deterministic repair:

```text
BROWSER_MATRIX_SCENARIO='Data City Protocol Zero truthful grid' \
APP_URL='http://127.0.0.1:4174/' CDP_PORT=9360 \
perl -e 'alarm 150; exec @ARGV' node tests/browser-matrix.mjs

not ok 1 - v3 Data City Protocol Zero truthful grid and real weapon victory
Error: Input.dispatchKeyEvent timed out
```

The timeout did not yield a valid terminal objective snapshot or a Boss result. Per the run budget, the Standard browser scenario was not retried. Abyss browser acceptance was **not run** in this round. Therefore firewall/traffic/clone/kernel victory, real-resource weapon proof, and cleanup remain unverified for both modes despite the deterministic route/pacing repairs. Temporary Vite `4174` and Chrome CDP `9360` processes were removed; the live v2.2 service on `4173` and its `9333` CDP endpoint were not touched.
