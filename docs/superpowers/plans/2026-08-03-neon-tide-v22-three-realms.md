# Neon Tide 2.2 Three Realms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Neon Tide 2.2.0 with four fully distinct worlds, audible adaptive background music, a pickup-charged narrow laser weapon, clearer hull/phase rules, stronger interaction feedback, and a harder but readable combat curve.

**Architecture:** Keep timing, balance, realm definitions, laser rules, and environment math in small pure modules; keep Three.js object ownership in focused renderer/controllers; keep `src/main.js` as the integration layer. The audio class owns a bus graph and beat scheduler, while realm backgrounds and environment events own fixed/pool-backed objects with explicit reset/dispose paths.

**Tech Stack:** Three.js 0.180, Web Audio API, Vite 7, ES modules, Node 22 `node:test`, Chrome DevTools Protocol browser matrix.

## Global Constraints

- Target version is `2.2.0`; keep the 100-second main route, 26-second Boss window, and 126-second total duration.
- The laser requires 100 energy, gains 5 per pickup or 7 with `overclock`, has 0.28-second charge, 0.32-second active time, length 7.2, full width 0.55, and at most 5 ordinary target hits.
- Remove automatic OVERDRIVE and all “shield charge” wording; three hull pips are health, while dash invulnerability is called phase state.
- Player collision radius becomes 0.37 and base visual scale becomes 0.88.
- Combat caps become 42 desktop and 32 coarse-pointer; spawn targets become 0.62/0.46/0.34 seconds with a 0.26 floor; formation cadence becomes 4–7 seconds.
- Realm order is Abyss 0–30, Data City 30–64, Star Forge 64–100, Void Cathedral 100–126.
- High-damage actions keep shape, direction, color, and time telegraphs; environment events never deal untelegraphed direct damage.
- No copyrighted external music/assets; generated Web Audio music must degrade safely when audio is unavailable.
- Mobile/coarse/reduced-motion modes retain gameplay timing and readable silhouettes while reducing decoration and post-processing cost.

---

## File Map

- `src/game/realms.js`: immutable realm, music, CSS, environment, and enemy-eligibility data.
- `src/game/skill.js`: pure weapon-energy, laser timing, line collision, penetration, and damage rules.
- `src/game/environment.js`: pure environment lifecycle and force/debuff calculations.
- `src/game/realm-backgrounds.js`: Three.js realm groups, transitions, quality budgets, resize, reset, and dispose.
- `src/game/audio.js`: Web Audio buses, adaptive layer scheduler, ducking, and varied event SFX.
- `src/game/config.js`: 2.2 combat caps, spawn cadence, upgrade copy/effects, projectile/background limits.
- `src/game/director.js`: consumes updated combat timing and stage eligibility without DOM/Three.js.
- `src/game/gameplay.js`: shared finite math plus projectile/laser helpers only where engine-independent.
- `src/main.js`: DOM/input/state integration, laser mesh/projectile pools, environment runtime, realm controller, enemy attack additions, cleanup.
- `index.html`: briefing, laser charge HUD, touch laser button, phase/hull copy.
- `src/style.css`: briefing layout, laser HUD/button, four realm-specific UI themes, responsive/reduced-motion behavior.
- `tests/realms.test.mjs`, `tests/skill.test.mjs`, `tests/environment.test.mjs`: new pure module coverage.
- `tests/audio.test.mjs`, `tests/director.test.mjs`, `tests/gameplay.test.mjs`, `tests/browser-matrix.mjs`: expanded regression/integration coverage.
- `README.md`, `docs/playtest/...`, `docs/releases/Neon-Tide-v2.2.0-release-notes.md`: updated operation, mechanics, results, and delivery.

---

### Task 1: Pure realm, laser, environment, and tuning foundations

**Files:**
- Create: `src/game/realms.js`
- Create: `src/game/skill.js`
- Create: `src/game/environment.js`
- Create: `tests/realms.test.mjs`
- Create: `tests/skill.test.mjs`
- Create: `tests/environment.test.mjs`
- Modify: `src/game/config.js`
- Modify: `src/game/director.js`
- Modify: `tests/director.test.mjs`

**Interfaces:**
- Produces: `REALMS`, `getRealm(index)`, `getRealmByElapsed(elapsed)`.
- Produces: `LASER_RULES`, `gainWeaponEnergy(current, focused)`, `canFireLaser(energy)`, `getLaserPhase(elapsed)`, `laserHitsCircle(beam, circle)`, `selectLaserTargets(candidates)`.
- Produces: `ENVIRONMENT_RULES`, `getEnvironmentDelay(realmId, seed)`, `getEnvironmentFrame(realmId, eventElapsed)`, `getCurrentForce(frame, point)`, `getDataLanePenalty(frame, point)`, `getGravityForce(frame, point)`.
- Later tasks consume these exact names; all returned objects are finite and immutable where practical.

- [ ] **Step 1: Write failing realm and combat tuning tests**

```js
// tests/realms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { REALMS, getRealm, getRealmByElapsed } from '../src/game/realms.js';

test('four realms own distinct art, music, css and environment identities', () => {
  assert.equal(REALMS.length, 4);
  assert.deepEqual(REALMS.map((realm) => realm.start), [0, 30, 64, 100]);
  assert.equal(new Set(REALMS.map((realm) => realm.id)).size, 4);
  assert.equal(new Set(REALMS.map((realm) => realm.cssTheme)).size, 4);
  assert.equal(new Set(REALMS.map((realm) => realm.music.bpm)).size, 4);
  assert.equal(new Set(REALMS.map((realm) => realm.environment.type)).size, 4);
  assert.equal(getRealm(2).id, 'star-forge');
  assert.equal(getRealmByElapsed(125).id, 'void-cathedral');
});
```

```js
// append to tests/director.test.mjs
test('2.2 pressure caps and spawn cadence are locked', () => {
  assert.equal(getActiveEnemyCap({ coarsePointer: false, viewportWidth: 1440 }), 42);
  assert.equal(getActiveEnemyCap({ coarsePointer: true, viewportWidth: 1440 }), 32);
  assert.deepEqual([getSpawnInterval(0, 0), getSpawnInterval(1, 30), getSpawnInterval(2, 64)], [0.62, 0.46, 0.34]);
  assert.equal(getSpawnInterval(2, 10_000), 0.26);
});
```

- [ ] **Step 2: Run realm/director tests and confirm missing modules/old constants fail**

Run:

```bash
export PATH="$PWD/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH"
node --test tests/realms.test.mjs tests/director.test.mjs
```

Expected: FAIL because `realms.js` does not exist and the current caps/cadence are 36/28 and 0.72/0.55/0.42.

- [ ] **Step 3: Implement immutable realm data and updated combat constants**

```js
// src/game/realms.js
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
};

export const REALMS = freeze([
  { index: 0, id: 'abyss', start: 0, end: 30, cssTheme: 'abyss', music: { bpm: 92, root: 45, scale: [0, 3, 5, 7, 10] }, environment: { type: 'current', interval: [7, 10], telegraph: 0.8 } },
  { index: 1, id: 'data-city', start: 30, end: 64, cssTheme: 'data-city', music: { bpm: 116, root: 50, scale: [0, 2, 5, 7, 9] }, environment: { type: 'data-lane', interval: [8, 11], telegraph: 0.9 } },
  { index: 2, id: 'star-forge', start: 64, end: 100, cssTheme: 'star-forge', music: { bpm: 132, root: 40, scale: [0, 1, 5, 7, 8] }, environment: { type: 'gravity-well', interval: [9, 12], telegraph: 1 } },
  { index: 3, id: 'void-cathedral', start: 100, end: 126, cssTheme: 'void-cathedral', music: { bpm: 140, root: 38, scale: [0, 1, 6, 7, 11] }, environment: { type: 'none', interval: [Infinity, Infinity], telegraph: 0 } },
]);

export const getRealm = (index = 0) => REALMS[Math.min(REALMS.length - 1, Math.max(0, Math.trunc(Number(index) || 0)))];
export const getRealmByElapsed = (elapsed = 0) => REALMS.findLast((realm) => Math.max(0, Number(elapsed) || 0) >= realm.start) ?? REALMS[0];
```

Modify `COMBAT` in `src/game/config.js` to `desktopEnemyCap: 42`, `coarsePointerEnemyCap: 32`, `spawnIntervals: [0.62, 0.46, 0.34]`, `spawnIntervalFloor: 0.26`, and `formationCooldown: { min: 4, max: 7 }`. Keep `minStage` gates unchanged.

- [ ] **Step 4: Write failing laser and environment rule tests**

```js
// tests/skill.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LASER_RULES, canFireLaser, gainWeaponEnergy, getLaserPhase, laserHitsCircle, selectLaserTargets } from '../src/game/skill.js';

test('twenty normal pickups charge one laser and firing requires full energy', () => {
  let energy = 0;
  for (let index = 0; index < 19; index += 1) energy = gainWeaponEnergy(energy, false);
  assert.equal(energy, 95);
  assert.equal(canFireLaser(energy), false);
  energy = gainWeaponEnergy(energy, false);
  assert.equal(energy, 100);
  assert.equal(canFireLaser(energy), true);
  assert.equal(gainWeaponEnergy(98, true), 100);
});

test('laser timing, narrow collision and penetration cap are stable', () => {
  assert.deepEqual(LASER_RULES, { maxEnergy: 100, pickupEnergy: 5, focusedPickupEnergy: 7, chargeDuration: 0.28, activeDuration: 0.32, length: 7.2, width: 0.55, maxTargets: 5 });
  assert.equal(getLaserPhase(0.1), 'charge');
  assert.equal(getLaserPhase(0.3), 'active');
  assert.equal(getLaserPhase(0.61), 'done');
  assert.equal(laserHitsCircle({ originX: 0, originY: 0, directionX: 1, directionY: 0 }, { x: 4, y: 0.2, radius: 0.1 }), true);
  assert.equal(laserHitsCircle({ originX: 0, originY: 0, directionX: 1, directionY: 0 }, { x: 4, y: 0.5, radius: 0.1 }), false);
  assert.equal(selectLaserTargets(Array.from({ length: 8 }, (_, index) => ({ id: index, along: 7 - index }))).length, 5);
});
```

```js
// tests/environment.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentForce, getDataLanePenalty, getEnvironmentDelay, getEnvironmentFrame, getGravityForce } from '../src/game/environment.js';

test('realm environments telegraph before active and never return non-finite forces', () => {
  const current = getEnvironmentFrame('abyss', 8);
  assert.ok(['telegraph', 'active', 'cooldown'].includes(current.phase));
  assert.ok(getEnvironmentDelay('abyss', 0.5) >= 7 && getEnvironmentDelay('abyss', 0.5) <= 10);
  assert.ok(Number.isFinite(getCurrentForce(current, { x: 0, y: 0 }).x));
  assert.ok(getDataLanePenalty(getEnvironmentFrame('data-city', 40), { x: 0, y: 0 }) >= 0);
  const gravity = getGravityForce(getEnvironmentFrame('star-forge', 76), { x: 2, y: -1 });
  assert.ok(Number.isFinite(gravity.x) && Number.isFinite(gravity.y));
  assert.equal(getEnvironmentFrame('void-cathedral', 110).phase, 'disabled');
});
```

- [ ] **Step 5: Implement laser and environment pure modules**

Implement `LASER_RULES` exactly as asserted. `gainWeaponEnergy(current, focused)` adds 5 or 7 and clamps to 100. `getLaserPhase(elapsed)` returns `charge`, `active`, or `done`. `laserHitsCircle()` projects the circle center onto the normalized beam direction, rejects `along < 0` or `along > 7.2`, then compares perpendicular distance with `0.275 + radius`. `selectLaserTargets()` filters finite non-negative `along`, sorts ascending, and returns the first five.

Implement `getEnvironmentDelay(realmId, seed)` by interpolating the realm's exact interval range with a clamped `0..1` seed. `getEnvironmentFrame(realmId, eventElapsed)` treats its time as local to one event: telegraph first, active for 3.2 seconds, then cooldown. Current force is at most 0.7 world units/second, data-lane penalty is `0.35` only inside the active band, and gravity acceleration is capped at `1.25` to prevent singularities.

- [ ] **Step 6: Run all pure tests**

```bash
npm test
```

Expected: all existing and new unit tests PASS.

- [ ] **Step 7: Commit foundations**

```bash
git add src/game/config.js src/game/director.js src/game/realms.js src/game/skill.js src/game/environment.js tests/director.test.mjs tests/realms.test.mjs tests/skill.test.mjs tests/environment.test.mjs
git commit -m "feat: add v2.2 realm and laser rule foundations"
```

---

### Task 2: Briefing, hull/phase clarity, smaller ship, and laser HUD/input

**Files:**
- Modify: `index.html`
- Modify: `src/style.css`
- Modify: `src/main.js`
- Modify: `tests/browser-matrix.mjs`

**Interfaces:**
- Consumes: `LASER_RULES.maxEnergy`, realm names from `REALMS`.
- Produces DOM IDs: `briefing-grid`, `journey-strip`, `weapon-energy-fill`, `weapon-energy-value`, `laser-status`, `laser-button`.
- Produces input function `requestLaser()` that only sets `input.laserBuffer = 0.14` while playing; Task 3 consumes the buffer.

- [ ] **Step 1: Add failing browser assertions for briefing and clear combat terminology**

Add a `briefingAndLaserUiScenario()` to `tests/browser-matrix.mjs` that asserts:

```js
const briefing = await page.evaluate(`({
  cards:document.querySelectorAll('#briefing-grid .mechanic-card').length,
  journey:document.querySelectorAll('#journey-strip li').length,
  copy:document.querySelector('#overlay-copy').textContent,
  energyLabel:document.querySelector('#mission-panel small').textContent,
  laserButton:Boolean(document.querySelector('#laser-button')),
  hullLabel:document.querySelector('.health-card > span').textContent,
})`);
assert.equal(briefing.cards, 4);
assert.equal(briefing.journey, 4);
assert.match(briefing.copy, /潮汐光矛/);
assert.doesNotMatch(briefing.energyLabel, /护盾|OVERDRIVE/);
assert.equal(briefing.laserButton, true);
assert.equal(briefing.hullLabel, '船体');
```

On 390×844, assert the briefing, joystick, dash button, and laser button remain within the viewport and do not overlap.

- [ ] **Step 2: Run the briefing scenario and verify it fails**

Run the Vite server and Chrome CDP, then:

```bash
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: FAIL because the briefing cards, journey strip, and laser button do not exist and shield/OVERDRIVE copy remains.

- [ ] **Step 3: Add briefing and laser controls to `index.html`**

Add four mechanic cards for Move, Phase Dash, Light Lance, and Hull; four journey items for the realm names/times; replace `护盾充能` with `光矛充能`; replace `overdrive-label` with `laser-status`; add a touch button:

```html
<button id="laser-button" class="laser-button" type="button" aria-label="潮汐光矛未充能" aria-disabled="true">
  <span>光矛</span><b>E</b>
</button>
```

Keep a single primary start button and keep all briefing content inside the existing dialog semantics.

- [ ] **Step 4: Style the briefing and responsive laser HUD/button**

Create a two-column `.briefing-grid` on desktop and one-column layout below 700px. Put the laser touch button above and left of the dash button so neither overlaps the mission panel. Add disabled, charging, and ready states using opacity, border color, and a conic progress ring; reduced-motion removes pulsing animation but preserves color and READY text.

- [ ] **Step 5: Integrate smaller player and laser input shell**

In `src/main.js`:

- set `player.radius = 0.37`;
- add `const PLAYER_VISUAL_SCALE = 0.88` and multiply idle/dash scale targets by it instead of resetting to 1;
- add `laserButton` and renamed energy/status DOM references;
- add `input.laserBuffer = 0` and `requestLaser()`;
- bind non-repeating `E`/`KeyE` plus `laser-button` pointerdown;
- set the button `aria-disabled`, label, and status from energy but do not fire until Task 3;
- rename user-facing `Echo Shield` to `相位外壳` and describe it as longer dash phase time.

- [ ] **Step 6: Run browser matrix and unit tests**

```bash
npm test
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: unit tests PASS; briefing and compact-layout scenarios PASS; existing gameplay scenarios remain green.

- [ ] **Step 7: Commit UI and terminology**

```bash
git add index.html src/style.css src/main.js tests/browser-matrix.mjs
git commit -m "feat: add v2.2 briefing and laser controls"
```

---

### Task 3: Replace OVERDRIVE with the pickup-charged light lance runtime

**Files:**
- Modify: `src/game/config.js`
- Modify: `src/main.js`
- Modify: `tests/gameplay.test.mjs`
- Modify: `tests/browser-matrix.mjs`

**Interfaces:**
- Consumes: every export from `src/game/skill.js`.
- Produces runtime functions `addWeaponEnergyFromPickup()`, `attemptLaser()`, `startLaserCharge()`, `updateLaser(dt)`, `resolveLaserHits()`, `clearLaserState()`.
- Produces test stats `laserShots`, `laserHits`, `laserInterrupts`, `laserPeakTargets`.

- [ ] **Step 1: Add failing browser coverage for pickup-only charging and manual firing**

Add a scenario that starts a run, calls the real pickup reward path 19 times, confirms 95 energy and no automatic mode, then one more pickup, presses `E`, and advances through charge/active/done:

```js
assert.deepEqual(beforeFire, { energy:100, state:'ready', shots:0 });
assert.deepEqual(charging, { energy:0, state:'charge', shots:1 });
assert.ok(active.visible && active.length === 7.2 && active.width === 0.55);
assert.deepEqual(done, { state:'idle', visible:false });
```

Inject six aligned chasers and assert only five receive damage, an off-axis enemy survives, a telegraphing Lancer is interrupted, and a Boss loses exactly 3 stability.

- [ ] **Step 2: Run browser matrix and confirm old OVERDRIVE behavior fails the new contract**

```bash
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: FAIL because pickup rewards auto-trigger OVERDRIVE and no laser state/mesh exists.

- [ ] **Step 3: Replace energy/OVERDRIVE state and upgrade derivation**

Remove `overdriveTimer`, `OVERDRIVE_MODIFIERS`, `triggerOverdrive()`, automatic energy activation, and `GAME.overdriveDuration`. Rename runtime energy to `weaponEnergy`. `getDerivedValues()` returns `pickupWeaponEnergy` equal to 7 when `overclock` is owned and 5 otherwise. Keep score, pickup radius, speed, and dash recovery independent of weapon energy.

Change `REWARDS` so pickup score remains unchanged but weapon charging only happens in the real shard collection path; near miss, break, and boss hit do not alter weapon energy.

- [ ] **Step 4: Create fixed laser meshes and lifecycle**

Create one player-owned `THREE.Group` containing a `PlaneGeometry(1, 1)` halo and white core. Place its local origin at the player nose, orient it to `laserDirection`, scale Y/full width to `0.55`, and scale X/length to `7.2` with geometry offset so the beam extends forward only. During charge, length grows from 0.4 to 7.2 and width from 0.08 to 0.55; during active, both remain fixed. Hide/reset on done, pause terminal cleanup, and restart; dispose owned materials at app teardown only.

- [ ] **Step 5: Implement pickup charging, firing, collision, and interruption**

`requestLaser()` only queues the 0.14-second input buffer. The playing update calls `attemptLaser()`; it clears the buffer and returns false below 100 energy, otherwise calls `startLaserCharge()`. `startLaserCharge()` consumes energy immediately, copies `player.facing`, increments `laserSequence`/`laserShots`, and sets `laserState='charge'`. `updateLaser(dt)` slows movement to 80% while charging, transitions to `active`, calls `resolveLaserHits()` every active frame, and finishes after 0.32 seconds.

For collision, compute `along` and perpendicular distance with `laserHitsCircle()`, sort by `along`, and use `selectLaserTargets()`. Track `enemy.lastLaserSequence` to ensure one hit. Apply damage by type exactly as the spec states. For ordinary enemy states containing `telegraph`, `chargeTelegraph`, or `shockTelegraph`, call `setEnemyState(enemy, 'recover', 0.5)` and increment `laserInterrupts`; never cancel active attacks or environment/Boss attack execution.

- [ ] **Step 6: Update HUD, feedback, and cleanup**

Show integer energy, bar width, `充能中`/`READY`/`蓄力`/`发射` states, and matching ARIA labels. Add `PIERCE ×N` feedback, stage-colored halo, low-duration white core flash, and no screen-wide flash. Reset weapon energy and laser state on a new run; clear only the active beam—not accumulated energy—when opening an upgrade dialog.

- [ ] **Step 7: Run complete tests and build**

```bash
npm test
npm run build
node --check src/main.js
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: all tests PASS; build has no error; only the known bundle-size warning may remain.

- [ ] **Step 8: Commit light lance runtime**

```bash
git add src/game/config.js src/main.js tests/gameplay.test.mjs tests/browser-matrix.mjs
git commit -m "feat: replace overdrive with charged light lance"
```

---

### Task 4: Audible adaptive music, buses, ducking, and stronger SFX

**Files:**
- Modify: `src/game/audio.js`
- Modify: `tests/audio.test.mjs`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `REALMS[index].music` and runtime `{ realTime, intensity, mode, laserReady, bossPhase }`.
- Produces: `setStage(index)`, `update(realTime, intensity, mode, context)`, `event(name, strength)`, `duck(amountDb, releaseSeconds)`, `getDebugSnapshot()`.
- Maintains buses: `masterGain`, `musicGain`, `sfxGain`, `ambienceGain`, `uiGain` and a compressor.

- [ ] **Step 1: Extend audio mocks and write failing mixer/scheduler tests**

Enhance `MockAudioContext` with `createDynamicsCompressor()`, `createBuffer()`, `createBufferSource()`, and connection recording. Add tests:

```js
test('audio creates four buses, audible music layers and safe master headroom', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  const snapshot = audio.getDebugSnapshot();
  assert.deepEqual(snapshot.buses, ['Music','SFX','Ambience','UI']);
  assert.ok(snapshot.masterGain > 0.68 && snapshot.masterGain < 0.76);
  audio.update(0, 0.8, 'playing', { laserReady:false, bossPhase:1 });
  assert.ok(audio.context.starts.length >= 2);
});

test('stage changes rephase at a bar and strong sfx ducks then releases music', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.setStage(1);
  audio.update(30, 0.7, 'playing', { laserReady:true, bossPhase:1 });
  audio.event('laserFire', 1);
  assert.ok(audio.getDebugSnapshot().musicTarget < audio.getDebugSnapshot().musicBase);
});
```

- [ ] **Step 2: Run audio tests and verify failure**

```bash
node --test tests/audio.test.mjs
```

Expected: FAIL because the current graph has only one master gain and one beat oscillator.

- [ ] **Step 3: Build the bus graph and safe gain mapping**

In `unlock()`, create bus gains and connect `Music`, `SFX`, `Ambience`, and `UI` into a compressor, then Master and destination. Set Master to linear gain equivalent of approximately `-3 dB` (`0.708`), Music `0.42`, SFX `0.72`, Ambience `0.28`, UI `0.5`. Route `_tone()` through a bus parameter instead of directly to Master. Clamp each one-shot layer to `0.12` and let the compressor protect summed peaks.

- [ ] **Step 4: Implement four-layer adaptive music**

Use each realm BPM/root/scale. Schedule at most one sixteenth-note grid event per update and rephase after mute/resume or a stale clock. Pad triggers once per bar with long sine/triangle envelopes; bass triggers on beats 1/3; pulse/noise drums enter above intensity 0.25; arp enters above 0.55 or when `laserReady`; Void Cathedral adds a detuned fifth in Boss phase 2. Do not schedule more than eight oscillator/noise starts in one update.

- [ ] **Step 5: Implement SFX variation and ducking**

Add recipes for `laserCharge`, `laserReady`, `laserFire`, `laserHit`, `environment`, and `realmShift`. Apply deterministic-enough random pitch multiplier in `[0.96, 1.04]`. `duck(-5, 0.34)` lowers Music with a 0.025-second target and restores with a 0.34-second target. Trigger ducking for dash, hurt, laserFire, bossHit, victory, and defeat.

- [ ] **Step 6: Integrate audio context data and verify**

Change the render-loop call to:

```js
audio.update(state.elapsed, intensity, state.mode, {
  laserReady: state.weaponEnergy >= LASER_RULES.maxEnergy,
  bossPhase: state.stats.bossPhase,
});
```

Run:

```bash
npm test
npm run build
```

Expected: audio and all unit tests PASS; no stale catch-up beats after mute/resume.

- [ ] **Step 7: Commit adaptive audio**

```bash
git add src/game/audio.js src/main.js tests/audio.test.mjs
git commit -m "feat: add adaptive realm music and audio buses"
```

---

### Task 5: Four independent realm backgrounds and UI themes

**Files:**
- Create: `src/game/realm-backgrounds.js`
- Modify: `src/main.js`
- Modify: `src/style.css`
- Modify: `tests/browser-matrix.mjs`

**Interfaces:**
- Consumes: `REALMS`, `renderQuality`, `scene`, viewport dimensions, reduced-motion state.
- Produces controller `createRealmBackgrounds({ scene, quality, width, height })` with `setRealm(index, immediate)`, `update({ elapsed, dt, reducedMotion })`, `resize(width, height)`, `reset()`, `dispose()`, `getStats()`.
- `getStats()` returns `{ activeRealm, visibleGroups, updateCounts, objectCounts, disposed }` for tests.

- [ ] **Step 1: Add failing browser realm-transition assertions**

Add a scenario that starts at each exact boundary and checks:

```js
assert.deepEqual(realms.map((entry) => entry.dataset), ['abyss','data-city','star-forge','void-cathedral']);
assert.ok(realms.every((entry) => entry.visibleGroups === 1));
assert.equal(new Set(realms.map((entry) => entry.signature)).size, 4);
assert.ok(realms.every((entry) => entry.inactiveUpdates === 0));
```

Also assert reduced-motion swaps immediately and coarse-pointer background object count is below desktop.

- [ ] **Step 2: Run browser matrix and verify current palette-only system fails**

Expected: FAIL because only one background group exists and `dataset.realm` is absent.

- [ ] **Step 3: Implement realm background controller with fixed resource ownership**

Create four groups once:

- Abyss: trench polygon silhouettes, three caustic line layers, 10/6 desktop/mobile jelly nodes, and bubble Points.
- Data City: three skyline layers, perspective lane LineSegments, packet Points, and hologram quads.
- Star Forge: corona rings, three crack line layers, debris Points, and two heat-lens circles.
- Void Cathedral: concentric octagonal rings, prism triangles, reverse-flow Points, and crack beams.

Each builder returns `{ group, materials, update(elapsed, dt, reducedMotion), resize(width,height), objectCount }`. Only active/transitioning builders update. `dispose()` traverses owned geometries/materials exactly once.

- [ ] **Step 4: Integrate realm switching and remove palette-only background updates**

Instantiate the controller after scene creation. On `enterStage()`, call `setRealm(nextStageIndex, state.reducedMotion)`, set `document.documentElement.dataset.realm`, call `audio.setStage()`, and show a banner with realm/environment copy. Retain combat palette colors for enemy intent but stop recoloring one generic background as the primary world change.

- [ ] **Step 5: Add four complete CSS realm themes**

Use selectors `[data-realm="abyss"]`, `[data-realm="data-city"]`, `[data-realm="star-forge"]`, `[data-realm="void-cathedral"]` to change HUD panel geometry, border treatment, scan pattern, mission panel accent, stage track, button highlight, and vignette. Keep body text contrast at least as strong as v2.1 and remove animations in reduced-motion.

- [ ] **Step 6: Verify realm visuals and lifecycle**

```bash
npm test
npm run build
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Capture one screenshot per realm with `Page.captureScreenshot`; visually confirm geometry—not only color—changes between all four.

- [ ] **Step 7: Commit realm rendering**

```bash
git add src/game/realm-backgrounds.js src/main.js src/style.css tests/browser-matrix.mjs
git commit -m "feat: add four independent realm art directions"
```

---

### Task 6: Environment rules, projectile attacks, and higher readable pressure

**Files:**
- Modify: `src/main.js`
- Modify: `src/game/config.js`
- Modify: `src/game/director.js`
- Modify: `src/game/gameplay.js`
- Modify: `tests/gameplay.test.mjs`
- Modify: `tests/director.test.mjs`
- Modify: `tests/browser-matrix.mjs`

**Interfaces:**
- Consumes: `getEnvironmentFrame()` and force/debuff helpers.
- Produces pooled runtime arrays `projectiles` and fixed `environmentVisual` objects.
- Produces functions `spawnProjectile(type, origin, direction, overrides)`, `updateProjectiles(dt)`, `applyEnvironment(dt)`, `clearEnvironmentAndProjectiles()`.
- Adds stats `projectilePeak`, `environmentEvents`, `environmentActiveFrames`, `realmAttackRoles`.

- [ ] **Step 1: Add failing pure projectile and live pressure tests**

In `tests/gameplay.test.mjs`, test a pure `projectileHitsCircle()` helper with finite position/velocity/radius and reject NaN. In the browser matrix, assert:

- desktop/coarse caps are 42/32;
- Stage 2 Lancer produces three slow bolts after its beam cycle;
- Stage 2 Striker fan telegraph has three visible rays but executes one readable lane;
- Stage 3 Mine chain detonation preserves at least 0.45-second delay per neighbor;
- Bulwark armor counter resets each attack and shows 0.55-second telegraph;
- Boss void shards never overlap a sweep-beam telegraph window;
- projectile peak stays below 72 desktop and 48 coarse.

- [ ] **Step 2: Run tests and verify attack contracts fail**

```bash
npm test
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: FAIL because projectiles and environment runtime do not exist and caps/cadence remain old in `main.js` targets.

- [ ] **Step 3: Integrate environment lifecycle and visuals**

Use one fixed visual per realm event: current band Plane + arrow LineSegments, data-lane Plane + grid, gravity-well ring group. Store `environmentTimer`, `environmentElapsed`, and a deterministic run seed; choose each delay through `getEnvironmentDelay()`, advance the local event frame with authoritative wall time, and increment `environmentEvents` once when telegraph begins. Apply current force to player/enemies/shards, data-lane `dashRecoveryMultiplier *= 0.65` and enemy steering response `*= 1.15` inside the band, and capped gravity force to player/enemies/shards. Clear on stage change, pause terminal cleanup, and restart.

- [ ] **Step 4: Add pooled projectiles and attack variants**

Create 72 projectile pool entries using shared circle/diamond geometry and per-entry material. Coarse mode may activate at most 48. Lancer spawns three bolts at angles `-0.18, 0, +0.18`, speed 3.2, life 2.4 seconds, damage 1. Striker displays three rays during telegraph and selects the center/left/right lane from deterministic `intentIndex`; only the selected ray remains during dash. Boss shards spawn five narrow diamonds in a fan, speed 4.1, damage 1, only when attack kind is `voidShards`.

- [ ] **Step 5: Add Mine chain and Bulwark armor counter**

When a Mine enters execute, enqueue neighboring Mines within 3.2 units with `chainDelay = max(existing, 0.45 + chainIndex * 0.12)`; they retain their own telegraph. When Bulwark takes dash/laser damage and its counter cooldown is zero, enter `armorCounterTelegraph` for 0.55 seconds, then emit one short ring; do not counter while already executing another shockwave.

- [ ] **Step 6: Update runtime pressure targets and formation timing**

Change target populations to `[15, 24, 34]`, formation timer reset to `COMBAT.formationCooldown.min + Math.random() * (max-min)`, and burst limits to `[2, 3, 4]` while always applying active cap, threat cost, health relief, and stage eligibility. Update finite guards for projectiles and environment state.

- [ ] **Step 7: Run full tests/build and commit**

```bash
npm test
npm run build
node --check src/main.js
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
git diff --check
```

```bash
git add src/main.js src/game/config.js src/game/director.js src/game/gameplay.js tests/gameplay.test.mjs tests/director.test.mjs tests/browser-matrix.mjs
git commit -m "feat: add realm hazards and expanded enemy attacks"
```

---

### Task 7: Final integration, accessibility, versioning, screenshots, and release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `index.html`
- Modify: `src/style.css`
- Modify: `src/game/config.js`
- Modify: `tests/browser-matrix.mjs`
- Modify: `docs/playtest/2026-08-03-neon-tide-hardness-report.md`
- Create: `docs/releases/Neon-Tide-v2.2.0-release-notes.md`
- Create artifact: `Neon-Tide-v2.2.0.zip`
- Create artifact: `Neon-Tide-v2.2.0.zip.sha256`

**Interfaces:**
- Consumes all prior tasks.
- Produces final version `2.2.0`, updated documentation, verified screenshots, release ZIP, and checksum.

- [ ] **Step 1: Expand final browser matrix acceptance**

Add assertions for:

- briefing focus trap and readable copy;
- keyboard `E` and touch laser input;
- laser unavailable below 100 and energy resets only on successful start;
- four realm datasets/background signatures/environment rules/music BPMs;
- no overlap among mobile mission, joystick, dash, and laser controls;
- reduced-motion removes realm transitions and strong pulse animations;
- pause freezes music scheduling, environment timing, projectiles, and laser;
- victory/timeout/restart leave zero active enemies, projectiles, hazards, laser meshes, and environment visuals;
- no NaN/Infinity in player, projectiles, background transforms, material opacity, audio scheduler, or environment state.

- [ ] **Step 2: Run final browser matrix before documentation changes**

```bash
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: PASS every scenario; fix any Critical/Important failure before continuing.

- [ ] **Step 3: Perform accessibility and copy pass**

Ensure the laser button uses `aria-disabled`, the charge bar has `role=progressbar` with min/max/now/text, realm/environment banners use polite live regions, and hull/phase copy contains no shield implication. Verify keyboard focus returns to Canvas after briefing, pause, and upgrade selection.

- [ ] **Step 4: Set version and update documentation**

Run:

```bash
npm version 2.2.0 --no-git-tag-version
```

Set `GAME.version` to `2.2.0`. Update README with controls, light-lance energy rules, four realms, audio behavior, environment rules, deployment, and reduced-motion behavior. Update the playtest report with actual test counts. Write release notes listing the known Vite chunk warning without claiming it is resolved.

- [ ] **Step 5: Run release verification**

```bash
npm test
npm run build
node --check src/main.js
node --check src/game/audio.js
node --check src/game/realm-backgrounds.js
node --check tests/browser-matrix.mjs
git diff --check
APP_URL=http://127.0.0.1:4173/ CDP_PORT=9333 node tests/browser-matrix.mjs
```

Expected: all commands PASS; only the acknowledged bundle-size warning may remain.

- [ ] **Step 6: Capture four realm screenshots**

Use Chrome CDP `Page.captureScreenshot` at representative elapsed times 12, 44, 78, and 108 seconds. Save to `docs/releases/screenshots/v2.2-abyss.png`, `v2.2-data-city.png`, `v2.2-star-forge.png`, and `v2.2-void-cathedral.png`. Inspect each image and confirm distinct geometry, HUD framing, environment motif, player/enemy readability, and no clipped mobile controls.

- [ ] **Step 7: Build the release archive and checksum**

Create a fresh staging directory containing `dist`, `src`, `tests`, `docs`, `index.html`, `package.json`, `package-lock.json`, `README.md`, and `vite.config.js`. Zip its contents to `Neon-Tide-v2.2.0.zip`, then write:

```bash
shasum -a 256 Neon-Tide-v2.2.0.zip > Neon-Tide-v2.2.0.zip.sha256
```

Extract to a fresh verification directory and use `diff -qr`/`cmp` to confirm staged source, docs, tests, package files, and fresh `dist` match the archive.

- [ ] **Step 8: Commit release metadata**

```bash
git add package.json package-lock.json README.md index.html src/style.css src/game/config.js tests/browser-matrix.mjs docs/playtest/2026-08-03-neon-tide-hardness-report.md docs/releases/Neon-Tide-v2.2.0-release-notes.md docs/releases/screenshots Neon-Tide-v2.2.0.zip.sha256
git commit -m "release: ship Neon Tide v2.2.0"
```

- [ ] **Step 9: Preserve the feature branch and start the verified static build**

Do not merge `feature/neon-tide-v22` into `main` without explicit approval. Copy the verified `dist` to a non-protected temporary serving directory, run a persistent local static server on port 4173, and confirm both `/` and the hashed JS/CSS assets return HTTP 200.

---

## Final Review Checklist

- Every spec section maps to a task: audio Task 4; laser/hull Tasks 2–3; realms Task 5; environment/difficulty Task 6; briefing/accessibility/release Task 7.
- All new runtime subsystems have a pure test boundary plus a live browser scenario.
- Names are consistent: `weaponEnergy`, `laserState`, `requestLaser`, `LASER_RULES`, `REALMS`, `createRealmBackgrounds`, `getEnvironmentFrame`.
- Cleanup covers restart, victory, defeat, pause, upgrade, stage transition, and app disposal.
- No task requires external copyrighted assets or new runtime dependencies.
