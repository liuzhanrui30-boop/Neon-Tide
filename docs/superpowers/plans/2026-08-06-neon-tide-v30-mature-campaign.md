# Neon Tide 3.0 Mature Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Neon Tide 3.0.0 as an 18–25 minute no-aim chapter-based bullet-hell Roguelite with anti-orbit encounters, automatic weapon builds, four distinct chapter bosses, Standard checkpoints, Abyss full-restart mode, richer 2.5D art, and release-grade performance/accessibility.

**Architecture:** Replace the 4,700-line integration monolith with a fixed-step `GameSession` plus focused systems and data-only content modules. Gameplay owns deterministic state and pools; render/audio/UI consume semantic snapshots and events. Migrate one playable vertical slice at a time so the game remains runnable and regression-tested throughout the refactor.

**Tech Stack:** Three.js 0.180, Vite 7, Web Audio API, ES modules, Node `node:test`, Chrome DevTools Protocol, LocalStorage, generated/programmatic original assets.

## Global Constraints

- Target version is `3.0.0`.
- Standard campaign duration is 18–25 minutes; Abyss mode uses the same chapters but full-run restart on death.
- Player input is movement + phase dash + one Tide Lance ultimate; no manual aiming, second stick, or second active skill.
- Automatic weapons choose targets; Tide Lance chooses its own high-value line and keeps the 0.28-second charge contract.
- Standard mode saves chapter-entry checkpoints; Abyss mode never restores a run after death.
- Four chapters are Abyss, Data City, Star Forge, and Void Cathedral, each with distinct objectives, art, music, environment rules, and a unique boss.
- Fixed-radius circling must fail to complete at least 90% of tested encounter seeds and must provoke a readable route change within 12 seconds.
- Standard active enemy caps are 48 desktop / 36 coarse; Abyss caps are 56 desktop / 42 coarse. Enemy projectile caps are 96 desktop / 72 coarse.
- High-damage attacks keep shape, direction, color, and at least 0.55–0.75 seconds of readable warning.
- The simulation uses fixed 60 Hz steps; pause/hidden time is discarded, while post-resume time is retained.
- Gameplay pools create no Geometry or Material per frame. Structural audits are dirty/lifecycle/low-frequency only.
- All music/assets must be original or programmatic. Audio failure must not break gameplay.
- Desktop target is stable 60 FPS; coarse devices target stable 30–45 FPS. Non-first-chapter heavy content must be lazy-loaded so the initial production JS target is below 500 kB before minification.
- Existing v2.2 live service remains available until 3.0 completes final release verification.

---

## File Map

- `src/main.js`: thin bootstrap only after Task 2.
- `src/app/bootstrap.js`: DOM, renderer, dependency construction, app disposal.
- `src/app/legacy-runtime.js`: temporary v2.2 compatibility adapter removed after the v3 vertical slice owns rendering and gameplay.
- `src/game/fixed-loop.js`: fixed-step accumulator and pause/resume clock contract.
- `src/game/session.js`: authoritative mode/chapter/room/build/hull/stat state.
- `src/game/entity-world.js`: entity IDs, typed pools, ownership, reset/dispose.
- `src/game/events.js`: bounded semantic event queue.
- `src/systems/input-system.js`: keyboard/touch/gamepad movement, dash, ultimate intent.
- `src/systems/player-system.js`: movement, dash charges, perfect phase, camera lead data.
- `src/systems/weapon-system.js`: automatic target selection, three starter weapons, Tide Lance auto-line.
- `src/systems/projectile-system.js`: friendly/enemy projectile pools and finite collision updates.
- `src/systems/objective-system.js`: room objectives and progress.
- `src/systems/anti-orbit-director.js`: route history, orbit pressure, counter selection.
- `src/systems/encounter-director.js`: threat budget, role selection, health relief, room completion.
- `src/systems/enemy-system.js`: eight enemy state machines and execution protection.
- `src/systems/collision-system.js`: player/enemy/projectile/objective collision outcomes.
- `src/systems/upgrade-system.js`: tagged upgrade pool and build derivation.
- `src/systems/boss-system.js`: generic boss phase/weak-point/cleanup controller.
- `src/systems/feedback-system.js`: semantic feedback timers and presentation events.
- `src/content/realms.js`: chapter metadata and lazy-content entry points.
- `src/content/enemies.js`: data-only enemy definitions.
- `src/content/encounters.js`: objective templates and seed rules.
- `src/content/upgrades.js`: 24 immutable upgrade definitions.
- `src/content/bosses/*.js`: four boss definitions.
- `src/render/entity-renderer.js`: pooled entity visuals.
- `src/render/realm-renderer.js`: chapter art controller and transitions.
- `src/render/hud-renderer.js`: HUD/accessibility projection.
- `src/audio/audio-engine.js`: music buses, bar scheduler, event SFX.
- `src/persistence/run-save.js`: versioned Standard checkpoint storage.
- `tests/*.test.mjs`: pure/module coverage.
- `tests/browser-matrix.mjs`: runner only.
- `tests/browser/*.mjs`: browser harness and grouped scenarios.

---

### Task 1: Stabilize the v2.2 audio boundary and establish the v3 regression gate

**Files:**
- Modify: `src/game/audio.js`
- Modify: `tests/audio.test.mjs`
- Create: `tests/browser/harness.mjs`
- Create: `tests/browser/v22-regressions.mjs`
- Modify: `tests/browser-matrix.mjs`

**Interfaces:**
- Produces `scheduleNextBeat(scheduleTime, gridInterval)` semantics where `nextBeatTime >= scheduleTime + gridInterval - 1e-9` after a late stage commit.
- Produces reusable browser exports `createBrowserHarness(options)` and `v22RegressionScenarios`.

- [ ] **Step 1: Add the failing late Stage 2→3 audio test**

```js
test('late bar-boundary realm commit rephases from the actual schedule time', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext, random: () => 0.5 });
  audio.unlock();
  audio.setStage(2);
  audio.update(64, 0.8, 'playing', { laserReady: false, bossPhase: 1 });
  const boundary = audio.getDebugSnapshot().pendingBoundary;
  audio.setStage(3);
  audio.context.currentTime = boundary + 0.11;
  audio.update(100, 0.8, 'playing', { laserReady: false, bossPhase: 1 });
  const snapshot = audio.getDebugSnapshot();
  const newGrid = 60 / 140 / 4;
  assert.ok(snapshot.nextBeatTime >= audio.context.currentTime + newGrid - 1e-9);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/audio.test.mjs`

Expected: FAIL because `nextBeatTime` is calculated from the expired boundary rather than the actual schedule time.

- [ ] **Step 3: Rephase late commits and preserve on-time lookahead**

Use the actual scheduled time when a pending stage commit is late; keep the exact boundary for on-time/lookahead commits. Do not change the existing eight-start limit or stale/future-source cleanup.

- [ ] **Step 4: Extract the browser harness without changing scenario behavior**

Move CDP transport, `GamePage`, breakpoint cleanup, viewport helpers, screenshot helpers, and static smoke utilities to `tests/browser/harness.mjs`. Move the current 24 v2.2 scenarios to `tests/browser/v22-regressions.mjs`. Keep `tests/browser-matrix.mjs` as ordering/configuration only.

- [ ] **Step 5: Run the v2.2 regression gate**

Run:

```bash
npm test
npm run build
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
BROWSER_MATRIX_BREAKPOINT_CLEANUP_SELF_TEST=1 node tests/browser-matrix.mjs
```

Expected: current unit suite and all 24 browser scenarios PASS.

- [ ] **Step 6: Commit the stable baseline**

```bash
git add src/game/audio.js tests/audio.test.mjs tests/browser-matrix.mjs tests/browser
git commit -m "fix: stabilize realm music and modularize browser tests"
```

---

### Task 2: Introduce the fixed loop, semantic events, and authoritative session

**Files:**
- Create: `src/game/fixed-loop.js`
- Create: `src/game/events.js`
- Create: `src/game/session.js`
- Create: `tests/fixed-loop.test.mjs`
- Create: `tests/session.test.mjs`
- Create: `tests/events.test.mjs`
- Create: `src/app/bootstrap.js`
- Create: `src/app/legacy-runtime.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces `createFixedLoop({ stepSeconds, maxCatchUpSteps, onStep, onRender })` with `tick(nowMs)`, `pause(nowMs)`, `resume(nowMs)`, `reset(nowMs)`, `getStats()`.
- Produces `createEventQueue(capacity = 256)` with `emit(type, payload)`, `drain(handler)`, `clear()`, `getStats()`.
- Produces `createGameSession(options)` with `startRun(mode, seed)`, `startRoom(room)`, `pause()`, `resume()`, `completeRoom(result)`, `damageHull(amount)`, `reset()`, `snapshot()`.

- [ ] **Step 1: Write fixed-loop failure tests**

```js
test('fixed loop discards pause time and retains post-resume time', () => {
  const steps = [];
  const loop = createFixedLoop({ stepSeconds: 1 / 60, maxCatchUpSteps: 6, onStep: (dt) => steps.push(dt), onRender: () => {} });
  loop.reset(0);
  loop.tick(16.7);
  loop.pause(20);
  loop.resume(5020);
  loop.tick(5120);
  assert.ok(steps.length >= 6);
  assert.ok(steps.length <= 7);
  assert.ok(steps.every((dt) => dt === 1 / 60));
});
```

- [ ] **Step 2: Write session transition tests**

Lock valid modes: `menu`, `briefing`, `playing`, `upgrade`, `paused`, `chapterComplete`, `victory`, `defeat`. Assert invalid transitions throw in development and return false in production mode.

- [ ] **Step 3: Run focused tests and confirm missing modules fail**

Run: `node --test tests/fixed-loop.test.mjs tests/events.test.mjs tests/session.test.mjs`

- [ ] **Step 4: Implement minimal modules, an explicit compatibility adapter, and thin bootstrap**

`src/main.js` becomes:

```js
import { bootstrapNeonTide } from './app/bootstrap.js';

const app = bootstrapNeonTide();
window.addEventListener('pagehide', () => app.dispose(), { once: true });
```

Move the current v2.2 DOM/Three.js setup into `createLegacyRuntime({ session, loop, events })` in `src/app/legacy-runtime.js`. The adapter exposes `start()`, `render(alpha)`, `applySession(snapshot)`, `reset()`, `dispose()`, and `getDebugSnapshot()`; it must not own `requestAnimationFrame`, authoritative mode, or pause clocks. `bootstrapNeonTide()` constructs the session/event queue/fixed loop, injects them into the adapter, owns the only animation frame callback, and returns `{ session, loop, events, dispose, getDebugSnapshot }`. Later tasks replace adapter subsystems until Task 16 deletes the adapter import and dead compatibility code.

- [ ] **Step 5: Verify pause, resume, terminal and replay through the browser matrix**

Add a `v3 foundation loop` scenario that asserts session and fixed-loop stats stay synchronized through pause, long stall, resume, defeat, and restart.

- [ ] **Step 6: Commit foundation ownership**

```bash
git add src/main.js src/app src/game/fixed-loop.js src/game/events.js src/game/session.js tests
git commit -m "refactor: add fixed loop and authoritative game session"
```

---

### Task 3: Add versioned Standard checkpoints and campaign mode rules

**Files:**
- Create: `src/persistence/run-save.js`
- Create: `tests/run-save.test.mjs`
- Modify: `src/game/session.js`
- Modify: `tests/session.test.mjs`
- Modify: `tests/browser/v22-regressions.mjs`

**Interfaces:**
- Produces `createRunSave(storage, key = 'neon-tide:v3:checkpoint')` with `save(checkpoint)`, `load()`, `clear()`, `getStatus()`.
- Checkpoint schema: `{ version:1, mode:'standard', seed, chapterIndex, build, hull, stats, savedAt }`.

- [ ] **Step 1: Write corrupt/mismatched checkpoint tests**

```js
test('checkpoint rejects Abyss saves and corrupt payloads safely', () => {
  const storage = new MemoryStorage();
  const save = createRunSave(storage);
  assert.equal(save.save({ version: 1, mode: 'abyss' }), false);
  storage.setItem('neon-tide:v3:checkpoint', '{broken');
  assert.equal(save.load(), null);
  assert.equal(save.getStatus().corruptions, 1);
});
```

- [ ] **Step 2: Add chapter-entry snapshot semantics**

Save only after a chapter transition completes and before the next room starts. Death in Standard restores that snapshot; death in Abyss clears runtime state and starts chapter 0 with a new run attempt but the same explicitly selected seed only in deterministic test mode.

- [ ] **Step 3: Run tests and implement storage**

Run: `node --test tests/run-save.test.mjs tests/session.test.mjs`.

- [ ] **Step 4: Add browser coverage for reload/resume/corrupt save**

Use real `localStorage`, reload the page, continue from chapter 2, then inject invalid JSON and verify the menu opens without a crash.

- [ ] **Step 5: Commit checkpoint persistence**

```bash
git add src/persistence src/game/session.js tests
git commit -m "feat: add standard checkpoints and abyss run rules"
```

---

### Task 4: Create EntityWorld, typed pools, and semantic render ownership

**Files:**
- Create: `src/game/entity-world.js`
- Create: `tests/entity-world.test.mjs`
- Create: `src/render/entity-renderer.js`
- Create: `tests/entity-renderer.test.mjs`
- Modify: `src/app/bootstrap.js`

**Interfaces:**
- Produces `createEntityWorld({ capacities })` with `spawn(kind, data)`, `despawn(id)`, `query(kind)`, `get(id)`, `reset()`, `dispose()`, `getStats()`.
- Entity kinds: `player`, `enemy`, `friendlyProjectile`, `enemyProjectile`, `pickup`, `objective`, `bossPart`.
- Produces `createEntityRenderer({ scene, quality, capacities })` with `sync(world, alpha)`, `reset()`, `dispose()`, `getStats()`.

- [ ] **Step 1: Lock generation-safe IDs and pool caps**

```js
test('stale entity IDs cannot mutate reused slots', () => {
  const world = createEntityWorld({ capacities: { enemy: 2 } });
  const first = world.spawn('enemy', { hp: 1 });
  world.despawn(first);
  const second = world.spawn('enemy', { hp: 2 });
  assert.notEqual(first, second);
  assert.equal(world.get(first), null);
  assert.equal(world.get(second).hp, 2);
});
```

- [ ] **Step 2: Implement fixed typed storage and bounded semantic events**

Use arrays/typed arrays allocated at construction. Spawn returns `null` at a hard cap and increments `rejectedSpawns`; it must not allocate a larger pool.

- [ ] **Step 3: Implement renderer ownership**

Precreate InstancedMesh/Points capacity for common enemies/projectiles. Boss parts and objectives may use fixed per-room objects. `sync()` mutates matrices/colors only.

- [ ] **Step 4: Add corruption and repeated reset tests**

Repeatedly corrupt a render slot, repair through explicit dirty audit, and assert scene child count, Geometry/Material count, and world capacity remain stable.

- [ ] **Step 5: Run tests/build and commit**

```bash
npm test
npm run build
git add src/game/entity-world.js src/render/entity-renderer.js src/app/bootstrap.js tests
git commit -m "refactor: add pooled entity world and renderer ownership"
```

---

### Task 5: Implement unified no-aim input, movement, camera lead, and phase dash

**Files:**
- Create: `src/systems/input-system.js`
- Create: `src/systems/player-system.js`
- Create: `tests/input-system.test.mjs`
- Create: `tests/player-system.test.mjs`
- Create: `src/render/hud-renderer.js`
- Modify: `src/app/bootstrap.js`
- Modify: `index.html`
- Modify: `src/style.css`
- Create: `tests/browser/v3-player.mjs`

**Interfaces:**
- Input snapshot: `{ moveX, moveY, dashPressed, ultimatePressed, inputDevice }`.
- Produces `updatePlayer(world, session, input, dt, events)`.
- Player state includes `velocity`, `facing`, `dashCharges[2]`, `dashTimer`, `phaseTimer`, `perfectPhaseWindow`, `cameraLead`.

- [ ] **Step 1: Write device-equivalence and no-aim tests**

Assert keyboard, touch joystick, and gamepad produce the same normalized move vector; assert pointer/mouse position never enters gameplay input.

- [ ] **Step 2: Lock movement and dash curves**

```js
test('player accelerates, turns and damps without teleporting velocity', () => {
  const player = createTestPlayer();
  updatePlayerState(player, { moveX: 1, moveY: 0 }, 1 / 60);
  assert.ok(player.velocity.x > 0 && player.velocity.x < player.maxSpeed);
  const before = player.velocity.x;
  updatePlayerState(player, { moveX: -1, moveY: 0 }, 1 / 60);
  assert.ok(player.velocity.x < before);
  assert.ok(player.velocity.x > -player.maxSpeed);
});
```

- [ ] **Step 3: Implement two-charge phase dash and perfect phase**

The same collision event that would damage the player checks the last dash activation time. A hit avoided within 0.12 seconds emits `perfectPhase`, refunds a bounded fraction of one charge, and grants a short automatic-weapon fire-rate buff.

- [ ] **Step 4: Replace legacy controls in a playable Abyss sandbox**

Keep only left movement control, Dash, and Tide Lance. Remove any aim affordance. Add gamepad mapping and focus-safe native button clicks.

- [ ] **Step 5: Browser-test 60/30 Hz equivalence and mobile layout**

Run a fixed input recording at 60 Hz and 30 Hz rendering; final simulated position must match within 0.03 world units. Verify 390×844 controls never overlap.

- [ ] **Step 6: Commit the player vertical slice**

```bash
git add src/systems/input-system.js src/systems/player-system.js src/render/hud-renderer.js src/app/bootstrap.js index.html src/style.css tests
git commit -m "feat: rebuild movement and phase dash for no-aim play"
```

---

### Task 6: Add automatic weapons and auto-selected Tide Lance

**Files:**
- Create: `src/systems/weapon-system.js`
- Create: `src/systems/projectile-system.js`
- Create: `src/systems/collision-system.js`
- Create: `tests/weapon-system.test.mjs`
- Create: `tests/projectile-system.test.mjs`
- Create: `tests/collision-system.test.mjs`
- Modify: `src/game/entity-world.js`
- Modify: `src/render/entity-renderer.js`
- Create: `tests/browser/v3-weapons.mjs`

**Interfaces:**
- Produces `selectAutoTarget(player, candidates, context)`.
- Produces `selectTideLanceLine(player, candidates, objectives)` returning `{ directionX, directionY, score, targetIds }`.
- Produces `resolveCollisions(world, session, dt, events)` with finite player/enemy/projectile/objective outcomes and perfect-phase routing.
- Starter weapons: `pulse-cannon`, `arc-drones`, `prism-missiles`.

- [ ] **Step 1: Test threat-priority targeting**

```js
test('auto target prioritizes executing threats and objectives over nearest fodder', () => {
  const target = selectAutoTarget({ x: 0, y: 0 }, [
    { id: 1, x: 1, y: 0, role: 'swarm', threat: 1 },
    { id: 2, x: 4, y: 0, role: 'lancer', executingTelegraph: true, threat: 5 },
    { id: 3, x: 3, y: 0, objective: true, threat: 4 },
  ], {});
  assert.equal(target.id, 2);
});
```

- [ ] **Step 2: Test automatic Tide Lance line search**

Sample a bounded set of candidate angles from target bearings and objective bearings. Score high-threat intersections, objective cores, Boss weak points, and distance; keep the current 0.28-second charge and a single optional retarget in the first half.

- [ ] **Step 3: Implement three starter weapons with fixed pools**

- Pulse Cannon: frequent straight homing correction toward one target.
- Arc Drones: two fixed drones and bounded chain candidates.
- Prism Missiles: slower homing projectiles with a fixed split count.

- [ ] **Step 4: Add sustained-fire audio/feedback rate limiting**

Emit aggregated `weaponFire` and `weaponHit` events, never one Web Audio graph per pellet.

- [ ] **Step 5: Browser-test no-input combat**

Hold the player still in a safe sandbox and assert automatic damage occurs with zero aim input; then move between targets and assert lock priority changes.

- [ ] **Step 6: Add finite collision resolution and commit automatic combat**

Resolve friendly/enemy projectile hits, pickup collection, player contact, objective overlap, perfect-phase avoidance, and despawn queues through `src/systems/collision-system.js`. Collision resolution must not create entities while iterating an active pool; deferred spawns are applied after the pass.

```bash
git add src/systems/weapon-system.js src/systems/projectile-system.js src/systems/collision-system.js src/game/entity-world.js src/render/entity-renderer.js tests
git commit -m "feat: add automatic weapons and smart Tide Lance"
```

---

### Task 7: Build objective rooms and deterministic encounter lifecycle

**Files:**
- Create: `src/systems/objective-system.js`
- Create: `src/systems/encounter-director.js`
- Create: `src/content/encounters.js`
- Create: `tests/objective-system.test.mjs`
- Create: `tests/encounters.test.mjs`
- Create: `tests/encounter-director.test.mjs`
- Modify: `src/game/session.js`
- Modify: `src/render/hud-renderer.js`
- Create: `tests/browser/v3-objectives.mjs`

**Interfaces:**
- Objective types: `purge`, `anchors`, `moving-zone`, `escort`, `elite-hunt`, `storm-corridor`, `core-harvest`, `dual-crisis`.
- Produces `createObjective(template, seed)` and `updateObjective(objective, world, player, dt, events)`.
- Produces `createEncounterDirector({ mode, quality, seed })` with `startRoom(template)`, `update(context, dt, events)`, `completeRoom()`, `reset()`, and `getSnapshot()`; Task 7 owns only deterministic room/threat lifecycle, while Tasks 8–9 extend counter and roster selection.

- [ ] **Step 1: Write completion/failure/progress tests for all eight types**

Each template defines exact progress units, timeout behavior, spawn hooks, safe-zone geometry, and cleanup. No objective completes from time passage alone except explicit survival segments inside `storm-corridor`.

- [ ] **Step 2: Add deterministic seeded placement**

For a fixed seed, anchor positions, moving-zone paths, escort routes, and dual-crisis choices must be identical across reload/checkpoint restore.

- [ ] **Step 3: Integrate room lifecycle and the minimal encounter director**

`GameSession.startRoom()` creates one objective and a room threat budget. Completion freezes combat, drains presentation events, offers an upgrade, then starts the next node.

- [ ] **Step 4: Add browser scenarios for route-changing objectives**

Run a fixed edge-circle input script. Assert anchors, moving zone, harvest, and escort make no progress until the route changes.

- [ ] **Step 5: Commit objective gameplay**

```bash
git add src/systems/objective-system.js src/systems/encounter-director.js src/content/encounters.js src/game/session.js src/render/hud-renderer.js tests
git commit -m "feat: add objective-driven encounter rooms"
```

---

### Task 8: Implement anti-orbit detection and readable route counters

**Files:**
- Create: `src/systems/anti-orbit-director.js`
- Create: `tests/anti-orbit-director.test.mjs`
- Modify: `src/content/encounters.js`
- Modify: `src/systems/objective-system.js`
- Modify: `src/systems/encounter-director.js`
- Create: `tests/browser/v3-anti-orbit.mjs`

**Interfaces:**
- Produces `createRouteHistory(capacity = 270)`.
- Produces `analyzeRoute(history, objectiveProgress)` returning `{ orbitPressure, direction, radiusVariance, quadrantCoverage, stalled }`.
- Counter kinds: `intercept`, `reverse-wall`, `objective-shift`, `center-pulse`.

- [ ] **Step 1: Write classifier tests**

```js
test('constant-radius same-direction motion raises orbit pressure but varied routes do not', () => {
  const circle = makeCircularSamples({ seconds: 4.5, radius: 8, direction: 1 });
  const varied = makeVariedSamples();
  assert.ok(analyzeRoute(circle, { delta: 0 }).orbitPressure >= 1);
  assert.equal(analyzeRoute(varied, { delta: 1 }).orbitPressure, 0);
});
```

- [ ] **Step 2: Implement tier selection and cooldown**

Require 3.5 seconds of consistent rotation, radius variance below 15%, and stalled objective progress. Only one counter may be active; after completion set a seven-second cooldown.

- [ ] **Step 3: Implement readable counter templates**

Interceptor preview is at least 0.65 seconds. Reverse wall always owns a safe gap. Objective shift displays its path before activation. Center pulse alternates edge danger with a readable center window.

- [ ] **Step 4: Run 100 seeded robot encounters**

Fixed-circle bot must fail or alter its route in at least 90 seeds. A varied-route bot must not receive more than one false counter in 100 seeds.

- [ ] **Step 5: Commit anti-cheese director**

```bash
git add src/systems/anti-orbit-director.js src/systems/encounter-director.js src/systems/objective-system.js src/content/encounters.js tests
git commit -m "feat: counter fixed orbit survival routes"
```

---

### Task 9: Add the eight-role enemy roster and threat-budget director

**Files:**
- Create: `src/content/enemies.js`
- Create: `src/systems/enemy-system.js`
- Modify: `src/systems/encounter-director.js`
- Create: `tests/enemy-system.test.mjs`
- Create: `tests/encounter-director-v3.test.mjs`
- Modify: `src/systems/collision-system.js`
- Modify: `src/render/entity-renderer.js`
- Create: `tests/browser/v3-enemies.mjs`

**Interfaces:**
- Enemy roles: `hunter`, `interceptor`, `striker`, `lancer`, `swarm`, `mine`, `warden`, `bulwark`.
- Produces `selectThreatWave(context, random)` and `updateEnemies(world, player, objective, dt, events)`.

- [ ] **Step 1: Lock role speeds, costs, stage gates, warnings and counters in data tests**

Every role definition includes `speedRange`, `threatCost`, `minChapter`, `telegraphSeconds`, `activeCap`, and `counterplay` text. High-damage warnings must be at least 0.55 seconds.

- [ ] **Step 2: Implement predictive Hunter and Interceptor movement**

Use bounded velocity prediction rather than reading future frames. Interceptor chooses a cut point 35–55 degrees ahead from anti-orbit context.

- [ ] **Step 3: Port Striker/Lancer/Swarm/Mine/Bulwark and add Warden**

Maintain execution protection, Mine chain delay, Bulwark counter tokens, independent warning materials, and projectile caps. Warden owns moving walls with guaranteed gaps.

- [ ] **Step 4: Implement threat-budget wave selection**

Apply hard cap, warning cap, blocked-area budget, objective burden, health relief, chapter gates, and device caps before spawning. Standard/Abyss caps use Global Constraints exactly.

- [ ] **Step 5: Browser-test concurrent warnings and natural role reachability**

Assert all eight roles appear through real encounter selection, simultaneous warning progress remains independent, and no high-damage warning is visually hidden.

- [ ] **Step 6: Commit the enemy roster**

```bash
git add src/content/enemies.js src/systems/enemy-system.js src/systems/encounter-director.js src/systems/collision-system.js src/render/entity-renderer.js tests
git commit -m "feat: add predictive enemy roles and threat budgeting"
```

---

### Task 10: Add 24 upgrades and three automatic-weapon build families

**Files:**
- Create: `src/content/upgrades.js`
- Create: `src/systems/upgrade-system.js`
- Create: `tests/upgrades.test.mjs`
- Create: `tests/upgrade-system.test.mjs`
- Modify: `src/game/session.js`
- Modify: `src/systems/weapon-system.js`
- Modify: `src/systems/player-system.js`
- Modify: `src/render/hud-renderer.js`
- Create: `tests/browser/v3-upgrades.mjs`

**Interfaces:**
- Upgrade tags: `overload`, `rift`, `tide`, `weapon`, `phase`, `lance`, `survival`, `objective`.
- Produces `offerUpgrades(build, seed, count = 3)` and `deriveBuildStats(build)`.

- [ ] **Step 1: Define and validate exactly 24 immutable upgrades**

Validation rejects duplicate IDs, missing localized copy, unknown tags, unbounded stacking, and an upgrade that adds a new active input.

- [ ] **Step 2: Implement deterministic three-choice offers**

No duplicate cards in one offer. Boss core rewards draw from a separate subset. Checkpoint restore with the same seed produces the same pending offer.

- [ ] **Step 3: Implement build-family behavior changes**

- Overload Chain modifies hit propagation and drone arcs.
- Rift Penetration modifies projectile traversal, weak points, and Tide Lance.
- Tide Escort modifies drones, pickup attraction, repairs, and objective proximity.

- [ ] **Step 4: Add upgrade UI and accessibility**

Cards state the behavior change, current/new stack, tags, and compatible starter weapon. Focus remains trapped and returns to the canvas after selection.

- [ ] **Step 5: Run a 10-choice deterministic build simulation**

Assert at least three viable tagged synergies, no extra input, finite derived stats, and checkpoint round-trip equality.

- [ ] **Step 6: Commit progression**

```bash
git add src/content/upgrades.js src/systems/upgrade-system.js src/game/session.js src/systems/weapon-system.js src/systems/player-system.js src/render/hud-renderer.js tests
git commit -m "feat: add automatic weapon build progression"
```

---

### Task 11: Assemble campaign routing, modes, chapter timing, and lazy content

**Files:**
- Create: `src/content/realms.js`
- Create: `src/game/campaign.js`
- Create: `tests/campaign.test.mjs`
- Modify: `src/game/session.js`
- Modify: `src/persistence/run-save.js`
- Modify: `src/app/bootstrap.js`
- Modify: `vite.config.js`
- Create: `tests/browser/v3-campaign.mjs`

**Interfaces:**
- Produces `CAMPAIGN_CHAPTERS` and `createCampaign(seed, mode)`.
- Chapter sequence: Abyss 3 rooms + Boss; Data City 3 + Boss; Star Forge 3 + Boss; Void Cathedral 2 + final Boss.
- Produces lazy loaders `loadChapterContent(chapterId)`.

- [ ] **Step 1: Test campaign length and room counts**

Seeded simulated completion using target durations must fall within 18–25 minutes and contain exactly 11 normal rooms plus four bosses.

- [ ] **Step 2: Implement Standard/Abyss route rules**

Standard writes chapter-entry checkpoints. Abyss increases configured pressure multipliers and never exposes Continue after death.

- [ ] **Step 3: Add chapter map and mode selection UI**

Menu copy clearly explains checkpoint vs full restart. Mode selection persists as preference but never auto-starts a run.

- [ ] **Step 4: Split chapter-heavy content into dynamic imports**

Use one chunk per non-Abyss chapter. Verify the first page load does not request Data/Forge/Void art or boss modules before needed.

- [ ] **Step 5: Browser-test full route, reload, and mode death behavior**

Use accelerated deterministic room completion without bypassing session transitions. Verify chapter order, 7–10 upgrade choices, Standard continue, and Abyss full reset.

- [ ] **Step 6: Commit campaign assembly**

```bash
git add src/content/realms.js src/game/campaign.js src/game/session.js src/persistence/run-save.js src/app/bootstrap.js vite.config.js index.html src/style.css tests
git commit -m "feat: assemble standard and abyss campaigns"
```

---

### Task 12: Build the Abyss chapter and Abyss Maw boss vertical slice

**Files:**
- Create: `src/content/chapters/abyss.js`
- Create: `src/content/bosses/abyss-maw.js`
- Create: `src/systems/boss-system.js`
- Create: `tests/abyss-chapter.test.mjs`
- Create: `tests/boss-system.test.mjs`
- Modify: `src/systems/objective-system.js`
- Modify: `src/systems/encounter-director.js`
- Create: `tests/browser/v3-abyss.mjs`

**Interfaces:**
- Abyss room set includes tutorial purge, moving zone, and anchors.
- Abyss Maw phases: `hunt`, `suction`, `weakPoints`, `enraged`.

- [ ] **Step 1: Write boss phase and cleanup tests**

Boss phase changes are driven by stability/weak-point outcomes, not timers alone. Cleanup removes boss parts, currents, minions, projectiles, music layer, and objective state.

- [ ] **Step 2: Implement Abyss room progression**

First 90 seconds must introduce Hunter, Swarm, Interceptor, Mine and two objective-route changes without exceeding the beginner warning budget.

- [ ] **Step 3: Implement Abyss Maw attacks and weak points**

Suction current changes route; tentacle fan owns gaps; jelly adds local pressure; bite closes a telegraphed zone. After suction, three organs become auto-target priorities.

- [ ] **Step 4: Browser-test fixed orbit failure and Standard checkpoint**

The circle bot must fail/provoke counters; a varied route completes. Defeat during Boss restores the chapter-entry checkpoint in Standard.

- [ ] **Step 5: Commit the first complete chapter**

```bash
git add src/content/chapters/abyss.js src/content/bosses/abyss-maw.js src/systems/boss-system.js src/systems/objective-system.js src/systems/encounter-director.js tests
git commit -m "feat: add Abyss chapter and Maw boss"
```

---

### Task 13: Build the Data City chapter and Protocol Zero boss

**Files:**
- Create: `src/content/chapters/data-city.js`
- Create: `src/content/bosses/protocol-zero.js`
- Create: `tests/data-city-chapter.test.mjs`
- Modify: `src/systems/boss-system.js`
- Modify: `src/systems/objective-system.js`
- Create: `tests/browser/v3-data-city.mjs`

**Interfaces:**
- Data rooms emphasize escort, storm corridor, and dual crisis.
- Protocol Zero phases: `firewall`, `trafficGrid`, `cloneNodes`, `kernel`.

- [ ] **Step 1: Test data-lane and objective interactions**

The lane debuff must affect dash recovery/steering without direct damage; escort and corridor progress freeze correctly on pause.

- [ ] **Step 2: Implement Data City room templates**

Use Striker, Lancer, Warden and Interceptor combinations with explicit safe lanes and capped simultaneous warnings.

- [ ] **Step 3: Implement Protocol Zero**

Firewall phases require entering marked quadrants. Traffic walls and predictive beams never close every route. Clone nodes use distinct shapes, not color alone.

- [ ] **Step 4: Browser-test truthful/false safe cells and deep mode variant**

Standard always displays one uniquely shaped true safe cell. Abyss may add decoys but preserves rhythm/shape evidence.

- [ ] **Step 5: Commit Data City**

```bash
git add src/content/chapters/data-city.js src/content/bosses/protocol-zero.js src/systems/boss-system.js src/systems/objective-system.js tests
git commit -m "feat: add Data City chapter and Protocol Zero"
```

---

### Task 14: Build the Star Forge chapter and Solar Foundry boss

**Files:**
- Create: `src/content/chapters/star-forge.js`
- Create: `src/content/bosses/solar-foundry.js`
- Create: `tests/star-forge-chapter.test.mjs`
- Modify: `src/systems/boss-system.js`
- Modify: `src/systems/objective-system.js`
- Create: `tests/browser/v3-star-forge.mjs`

**Interfaces:**
- Forge rooms emphasize elite hunt, core harvest, and gravity-altered purge.
- Solar Foundry phases: `armor`, `meteorGuide`, `core`, `reverseOrbit`.

- [ ] **Step 1: Test gravity consistency and meteor ownership**

Gravity affects all movable gameplay entities through fixed steps. Meteor impact can damage Boss armor only after its telegraph and never damages through pause.

- [ ] **Step 2: Implement Forge room templates**

Use Mine chains, Bulwark counter, Warden walls and high-speed Interceptors with threat-budget enforcement.

- [ ] **Step 3: Implement Solar Foundry**

Players guide telegraphed meteors into armor; automatic weapons then target the core. Reverse orbit changes gravity direction but provides a one-second transition warning.

- [ ] **Step 4: Browser-test no permanent outer-ring solution**

Fixed-radius scripts must be intercepted by gravity/objective/meteor mechanics while varied routes remain completable.

- [ ] **Step 5: Commit Star Forge**

```bash
git add src/content/chapters/star-forge.js src/content/bosses/solar-foundry.js src/systems/boss-system.js src/systems/objective-system.js tests
git commit -m "feat: add Star Forge chapter and Solar Foundry"
```

---

### Task 15: Build Void Cathedral and the four-phase Void Regent finale

**Files:**
- Create: `src/content/chapters/void-cathedral.js`
- Create: `src/content/bosses/void-regent.js`
- Create: `tests/void-cathedral.test.mjs`
- Modify: `src/systems/boss-system.js`
- Modify: `src/game/session.js`
- Create: `tests/browser/v3-finale.mjs`

**Interfaces:**
- Void rooms are two high-pressure elite/objective encounters.
- Regent phases: `symmetry`, `ritualNodes`, `routeMirror`, `collapse`; Abyss adds `lastLight`.

- [ ] **Step 1: Test phase gates, invulnerable nodes and final cleanup**

During `ritualNodes`, Boss damage is disabled and two objective nodes must fall. Victory clears every enemy, projectile, objective, environment, audio voice, render transition, and checkpoint.

- [ ] **Step 2: Implement mirrored-route attacks safely**

Mirror a delayed, simplified route sample, not the player's exact future position. Show the mirrored path before firing and cap combined warnings.

- [ ] **Step 3: Implement collapse and Abyss final phase**

Arena contraction leaves explicit minimum safe area. `lastLight` recombines attacks but never overlaps two full-screen high-damage windows.

- [ ] **Step 4: Run full 18–25 minute accelerated and real-time flows**

Accelerated automation validates state/cleanup; at least one real-time Standard and one real-time Abyss playthrough validates pacing and audio.

- [ ] **Step 5: Commit the complete campaign**

```bash
git add src/content/chapters/void-cathedral.js src/content/bosses/void-regent.js src/systems/boss-system.js src/game/session.js tests
git commit -m "feat: add Void Cathedral and final Regent battle"
```

---

### Task 16: Replace abstract line art with layered 2.5D chapter art

**Files:**
- Create: `src/render/realm-renderer.js`
- Create: `src/render/material-library.js`
- Create: `src/assets/generated/abyss/manifest.json`
- Create: `src/assets/generated/abyss/backdrop.svg`
- Create: `src/assets/generated/abyss/midground.svg`
- Create: `src/assets/generated/abyss/foreground.svg`
- Create: `src/assets/generated/data-city/manifest.json`
- Create: `src/assets/generated/data-city/backdrop.svg`
- Create: `src/assets/generated/data-city/midground.svg`
- Create: `src/assets/generated/data-city/foreground.svg`
- Create: `src/assets/generated/star-forge/manifest.json`
- Create: `src/assets/generated/star-forge/backdrop.svg`
- Create: `src/assets/generated/star-forge/midground.svg`
- Create: `src/assets/generated/star-forge/foreground.svg`
- Create: `src/assets/generated/void-cathedral/manifest.json`
- Create: `src/assets/generated/void-cathedral/backdrop.svg`
- Create: `src/assets/generated/void-cathedral/midground.svg`
- Create: `src/assets/generated/void-cathedral/foreground.svg`
- Create: `src/assets/generated/enemies/manifest.json`
- Create: `src/assets/generated/enemies/enemy-atlas.svg`
- Create: `src/assets/generated/bosses/manifest.json`
- Create: `src/assets/generated/bosses/abyss-maw.svg`
- Create: `src/assets/generated/bosses/protocol-zero.svg`
- Create: `src/assets/generated/bosses/solar-foundry.svg`
- Create: `src/assets/generated/bosses/void-regent.svg`
- Delete: `src/app/legacy-runtime.js`
- Modify: `src/style.css`
- Modify: `src/app/bootstrap.js`
- Create: `tests/realm-renderer-v3.test.mjs`
- Create: `tests/browser/v3-art.mjs`

**Interfaces:**
- Produces `createRealmRenderer({ scene, quality, assetLoader })` with `preloadChapter(id)`, `setChapter(id, immediate)`, `update(snapshot, alpha)`, `resize()`, `reset()`, `dispose()`, `getStats()`.

- [ ] **Step 1: Define asset manifests and acceptance metadata**

Every generated asset records origin prompt/tool, dimensions, color space, intended layer, and license status `original-generated`. Reject missing metadata in tests.

- [ ] **Step 2: Produce four chapter landmark sets and entity atlases**

Use original generated textures/sprites plus programmatic geometry. Preserve the spec palettes and recognizable landmarks. Do not import copyrighted source imagery.

- [ ] **Step 3: Implement layered parallax and material tiers**

Far/mid/near layers use fixed objects and shared textures. Desktop uses higher-resolution texture/shader tiers; coarse mode preserves landmark silhouette while reducing particle layers.

- [ ] **Step 4: Replace enemy/Boss outlines with filled readable assets**

Keep consistent threat colors and telegraph shapes. Bosses have independent parts and weak-point visuals.

- [ ] **Step 5: Capture and inspect combat screenshots**

Capture each chapter during a normal room and Boss. Automated checks require unique perceptual signatures, foreground contrast, no center obstruction, no clipped controls, and stable object/material counts.

- [ ] **Step 6: Commit 2.5D art**

```bash
git add src/render src/assets/generated src/style.css src/app/bootstrap.js tests
git commit -m "feat: add layered 2.5D chapter art"
```

---

### Task 17: Rebuild adaptive audio, campaign UI, accessibility, and settings

**Files:**
- Create: `src/audio/audio-engine.js`
- Create: `tests/audio-engine-v3.test.mjs`
- Modify: `src/app/bootstrap.js`
- Modify: `src/render/hud-renderer.js`
- Modify: `index.html`
- Modify: `src/style.css`
- Create: `tests/browser/v3-accessibility.mjs`

**Interfaces:**
- Audio consumes `{ chapterId, bossPhase, intensity, perfectPhase, objectiveState, mode }` and semantic events.
- Settings: reduced motion, danger outline, shake strength, master/music/SFX volumes.

- [ ] **Step 1: Port four buses and add chapter/Boss music states**

Music changes at bar boundaries. Late changes schedule from actual time plus the new grid interval. Old/future voices fade/stop safely; no update starts more than eight sources.

- [ ] **Step 2: Add automatic-fire rate limiting and semantic cues**

Aggregate rapid fire/hits. Add distinct anti-orbit, objective migration, weak point, perfect phase, checkpoint and Boss phase cues.

- [ ] **Step 3: Build campaign map, objective HUD and settings**

Objective text and progress occupy the upper safe area. No giant center banner. Upgrade and checkpoint states use modal focus traps.

- [ ] **Step 4: Complete accessibility coverage**

Test keyboard/touch/gamepad, native button activation, progressbar truthfulness, forced colors, reduced motion, danger outlines, focus return, and screen-reader Boss/objective announcements.

- [ ] **Step 5: Commit audio/UI completion**

```bash
git add src/audio src/app/bootstrap.js src/render/hud-renderer.js index.html src/style.css tests
git commit -m "feat: complete campaign audio and accessible UI"
```

---

### Task 18: Performance, playtest balance, version 3.0.0, and release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `src/game/config.js`
- Modify: `vite.config.js`
- Modify: `tests/browser-matrix.mjs`
- Create: `docs/playtest/2026-08-06-neon-tide-v30-playtest.md`
- Create: `docs/releases/Neon-Tide-v3.0.0-release-notes.md`
- Create: `docs/releases/screenshots/v3/standard-map.png`
- Create: `docs/releases/screenshots/v3/upgrade-build.png`
- Create: `docs/releases/screenshots/v3/mobile-controls.png`
- Create: `docs/releases/screenshots/v3/accessibility-danger-outline.png`
- Create: `docs/releases/screenshots/v3/abyss-room.png`
- Create: `docs/releases/screenshots/v3/abyss-boss.png`
- Create: `docs/releases/screenshots/v3/data-city-room.png`
- Create: `docs/releases/screenshots/v3/data-city-boss.png`
- Create: `docs/releases/screenshots/v3/star-forge-room.png`
- Create: `docs/releases/screenshots/v3/star-forge-boss.png`
- Create: `docs/releases/screenshots/v3/void-cathedral-room.png`
- Create: `docs/releases/screenshots/v3/void-cathedral-boss.png`
- Create artifact: `Neon-Tide-v3.0.0.zip`
- Create artifact: `Neon-Tide-v3.0.0.zip.sha256`

**Interfaces:**
- Produces final version `3.0.0`, reproducible archive, checksum, screenshots, live build, and preserved feature branch.

- [ ] **Step 1: Add long-run performance and leak scenarios**

Run 25 simulated minutes plus repeated chapter restarts. Assert pool caps, listener counts, scene children, Geometry/Material counts, audio voices, audit frequency, save size, and heap trend remain bounded.

- [ ] **Step 2: Run balance bots and record results**

For at least 100 seeds per representative objective:

- fixed circle completes fewer than 10%;
- varied-route bot completes at least 70% Standard tutorial rooms;
- Standard scripted full runs land within 18–25 minutes;
- Abyss pressure multipliers and full-restart semantics remain active.

- [ ] **Step 3: Perform human playtest passes**

Record movement feel, first-90-second variety, build identity, Boss clarity, art readability, audio fatigue, Standard checkpoint usefulness, and Abyss frustration/fairness. Tune through data modules, not ad hoc runtime branches.

- [ ] **Step 4: Enforce performance and bundle gates**

Measure desktop 1440p and coarse 390×844/1024×768. Initial JS before minification must be below 500 kB; later chapter chunks must load only when entering/preloading their chapter.

- [ ] **Step 5: Set version and documentation**

Run `npm version 3.0.0 --no-git-tag-version`. Update visible build label, README controls/modes/checkpoints, playtest report, and release notes. Document only real remaining warnings.

- [ ] **Step 6: Capture release screenshots**

Capture one normal room and one Boss per chapter, plus Standard map, upgrade build, mobile controls and accessibility modes. Inspect every image.

- [ ] **Step 7: Run the final release gate**

```bash
npm test
npm run build
find src tests \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
git diff --check
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: all unit/browser/performance/release checks PASS.

- [ ] **Step 8: Build and verify the release archive**

Stage fresh `dist`, source, tests, docs, assets, package files, README and Vite config. Exclude `.git`, `.worktrees`, `.runtime`, `.superpowers`, `node_modules`, temp files and source maps. Zip, checksum, extract, diff, then smoke-test desktop and 390×844 from the extracted artifact.

- [ ] **Step 9: Preserve the feature branch and replace the live service**

Do not merge without approval. Copy the verified extracted `dist` to a new `/tmp/neon-tide-v30-live-*` directory, replace `com.openai.neontide.v22` with `com.openai.neontide.v30`, and verify `/` plus every hashed JS/CSS asset returns HTTP 200.

- [ ] **Step 10: Commit release metadata**

```bash
git add package.json package-lock.json README.md src/game/config.js vite.config.js tests docs Neon-Tide-v3.0.0.zip.sha256
git commit -m "release: ship Neon Tide v3.0.0"
```

---

## Final Review Checklist

- No manual aim input exists in code, UI, docs, or accessibility labels.
- Fixed-loop/session/entity ownership replaced legacy timing and mode mutation.
- Standard checkpoint and Abyss full-restart behaviors survive reload and corrupt storage.
- Automatic weapons, Tide Lance, eight enemies, eight objectives, 24 upgrades and four Bosses are reachable through natural play.
- Fixed-radius circle bots fail the stated acceptance target without invisible punishment.
- Four chapters have distinct gameplay, art, music, landmarks and bosses.
- Pause, upgrade, chapter transition, death, retry and victory have explicit cleanup/freeze tests.
- Structural audits and render/audio resource ownership remain bounded over a full 25-minute run.
- Desktop/mobile/reduced-motion/forced-colors/gamepad/browser flows pass.
- Version, docs, screenshots, ZIP, checksum, extracted smoke and live build match the same final commit.
