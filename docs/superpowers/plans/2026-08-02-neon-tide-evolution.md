# Neon Tide 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 45 秒收集躲避原型升级为约 65 秒、包含模块选择、三种敌人、自动超载和首领决战的短局动作 Roguelite。

**Architecture:** 平衡数据、纯玩法计算和音频分别放入独立模块，`src/main.js` 作为唯一运行时状态所有者与帧循环编排者。玩法时间受慢动作缩放，倒计时、音频调度、UI 和反馈衰减使用真实时间，避免结算和暂停竞态。

**Tech Stack:** Three.js 0.180.x、Vite 7.x、原生 ES Modules、Web Audio、CSS、Node 内置测试。

## Global Constraints

- 不增加运行时依赖，不引入图片、模型或音频下载。
- 仍只要求玩家使用移动和冲刺；触屏完整可玩。
- 同屏敌人上限 24、活动粒子上限 220、拖尾节点上限 36。
- `prefers-reduced-motion` 时关闭慢镜、缩放脉冲和强震动。
- Vite `base` 保持 `./`，生产包必须支持子路径托管。

---

## File Structure

- Create `src/game/config.js`: 平衡常量、阶段、敌人、模块与调色板数据。
- Create `src/game/gameplay.js`: `getStageIndex`、`getStage`、`computeSpawnBudget`、`computeReward`、`computeRank`、`pickUpgradeOptions` 纯函数。
- Create `src/game/audio.js`: `NeonAudio`，统一管理音频解锁、语义音效和分阶段节拍。
- Rewrite `src/main.js`: 状态机、Three.js 场景、实体行为、碰撞、导演、反馈和 DOM 同步。
- Modify `index.html`: 阶段、冲刺、首领、模块选择和详细结算界面。
- Rewrite `src/style.css`: 新 HUD、模块卡、阶段横幅、移动端和可访问样式。
- Create `tests/gameplay.test.mjs`: 纯玩法逻辑边界测试。
- Modify `package.json`: 增加 `test`、`check` 脚本和 2.0.0 版本。
- Modify `README.md`: 更新玩法、系统和构建说明。

---

### Task 1: 数据模型与纯玩法计算

**Files:**
- Create: `src/game/config.js`
- Create: `src/game/gameplay.js`
- Create: `tests/gameplay.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `GAME`, `STAGES`, `ENEMY_TYPES`, `UPGRADES`, `getStageIndex(elapsed)`, `getStage(elapsed)`, `computeSpawnBudget(elapsed, health, score)`, `computeReward(kind, combo, multiplier)`, `computeRank(stats)`, `pickUpgradeOptions(ownedIds, random, count)`.

- [ ] **Step 1: Write boundary tests**

Test exact stage boundaries at 0/18/38/53 seconds, spawn-budget health relief, combo reward caps, deterministic upgrade uniqueness, and S/A/B/C rank thresholds using `node:test` and `node:assert/strict`.

- [ ] **Step 2: Run tests and confirm initial failure**

Run: `npm test`

Expected: FAIL because `src/game/gameplay.js` does not exist.

- [ ] **Step 3: Implement configuration and pure functions**

Use immutable exported objects. Inject the random function into `pickUpgradeOptions` so tests do not depend on global randomness.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: all tests pass with exit code 0.

### Task 2: 音频系统

**Files:**
- Create: `src/game/audio.js`

**Interfaces:**
- Produces: `new NeonAudio()`, `unlock()`, `setMuted(boolean)`, `setStage(index)`, `update(realTime, intensity, mode)`, `event(name, strength)`, `suspendBeat()`.
- Consumes: semantic names `start`, `pickup`, `nearMiss`, `dash`, `break`, `hurt`, `overdrive`, `upgrade`, `bossHit`, `victory`, `defeat`.

- [ ] **Step 1: Implement a guarded Web Audio owner**

Create oscillators and gains only after a user gesture. Ensure calls are no-ops when Web Audio is unavailable, muted, or suspended.

- [ ] **Step 2: Implement semantic SFX recipes**

Map each event to distinct frequency ranges and at most two oscillator layers. Clamp output gain below 0.08 per layer.

- [ ] **Step 3: Implement phase-aware beat scheduling**

Use `audioContext.currentTime` and a next-beat timestamp; schedule no more than one beat ahead per update and stop scheduling outside playing mode.

### Task 3: UI semantic structure

**Files:**
- Modify: `index.html`
- Rewrite: `src/style.css`

**Interfaces:**
- Produces DOM IDs: `stage-name`, `stage-progress`, `dash-pips`, `overdrive-label`, `boss-panel`, `boss-fill`, `stage-banner`, `upgrade-panel`, `upgrade-options`, `result-combo`, `result-near`, `result-breaks`, `result-rank`, `mute-button`.

- [ ] **Step 1: Add HUD and overlay elements**

Keep gameplay controls outside modal overlays. Add `aria-live` only to stage and toast messaging, not rapidly changing score nodes.

- [ ] **Step 2: Add upgrade card layout**

Each card is a real button with a number hint, title, description, and effect value. The panel must fit 360 px wide portrait screens.

- [ ] **Step 3: Add responsive and reduced-motion CSS**

Preserve safe-area insets. At widths below 760 px, compress the HUD into two rows and keep touch controls above all non-modal HUD.

### Task 4: Runtime state machine and movement

**Files:**
- Rewrite: `src/main.js`

**Interfaces:**
- Consumes configuration, gameplay helpers, `NeonAudio`, and Task 3 DOM IDs.
- Produces mode transitions through `transitionTo(nextMode, payload)` only.

- [ ] **Step 1: Define state ownership and transition guards**

Modes are `menu`, `playing`, `upgrade`, `paused`, `gameover`, `victory`. Only `transitionTo` changes `state.mode`; `finishRun` has a one-way latch.

- [ ] **Step 2: Implement responsive movement**

Use separate acceleration, turn acceleration and damping. Preserve velocity during heading changes, add camera look-ahead, visual banking and input buffering for dash.

- [ ] **Step 3: Implement two independent dash charges**

Consume one available charge, recover each slot from 0 to 1, and render both HUD/mobile rings. Dash grants invulnerability and attack state for the same 0.19-second window.

### Task 5: Entities, director and combat

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Produces factories and update paths for `chaser`, `striker`, `mine`, `elite`, and `boss` entities.

- [ ] **Step 1: Implement distinct enemy factories**

Reuse shared geometries and materials by archetype. Every archetype exposes `type`, `radius`, `hp`, `state`, `telegraph`, `velocity`, `nearMissed`, and `dead`.

- [ ] **Step 2: Implement readable behavior states**

Strikers use `track → telegraph → dash → recover`; mines use `arming → detonate`; boss uses `enter → choose → telegraph → execute → recover`.

- [ ] **Step 3: Implement combat collision priority**

Resolve player dash attacks before player damage. A destroyed enemy cannot damage in the same frame. Boss core only accepts damage during player dash.

- [ ] **Step 4: Implement stage director**

At 18 and 38 seconds enter upgrade mode once. At 53 seconds clear low-priority hazards, show the boss banner, and spawn exactly one boss. Limit total enemies and mines per global constraints.

### Task 6: Rewards, overdrive and progression

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `computeReward`, `pickUpgradeOptions`, `UPGRADES`.
- Produces: `addEnergy(amount)`, `triggerOverdrive()`, `applyUpgrade(id)`, `registerNearMiss(enemy)`, `destroyEnemy(enemy, source)`.

- [ ] **Step 1: Connect all reward sources**

Pickup, near miss and dash break must add score, combo and energy with different values. Damage clears combo but never removes owned upgrades.

- [ ] **Step 2: Implement automatic overdrive**

At 100 energy set energy to 0 and run a 5-second timer. Apply multipliers through derived values rather than mutating base configuration.

- [ ] **Step 3: Implement two upgrade selections**

Pause simulation while showing three options. Support click/tap and keys 1/2/3. Apply the selected module once and resume with a 0.8-second invulnerability grace period.

### Task 7: Layered game feel and art direction

**Files:**
- Modify: `src/main.js`
- Modify: `src/style.css`

**Interfaces:**
- Produces: `addTrauma(amount)`, `triggerSlowMotion(scale, duration)`, `spawnTrail()`, `showFloatingText()`, `showStageBanner()`, `setPalette(stageIndex)`.

- [ ] **Step 1: Replace random shake with trauma shake**

Decay trauma in real time, square its output, and sample summed sine waves. Scale to zero for reduced-motion users.

- [ ] **Step 2: Add event-tier feedback bundles**

Pickup uses small feedback; enemy break, hurt and boss hit use medium; overdrive, boss entrance, victory and defeat use large feedback. All effects return to rest.

- [ ] **Step 3: Add stage palette and battlefield motion**

Lerp scene background, grid, fog glow, decor rings and CSS accent variables from current to target stage palette. Add capped player trails and flow-line motion.

- [ ] **Step 4: Upgrade player and boss silhouettes**

Add ship wings, a pulsing core, layered dash afterimages, boss rotating rings and a hit-reactive core without external assets.

### Task 8: Results, documentation and release verification

**Files:**
- Modify: `README.md`
- Rebuild: `dist/`
- Rebuild: `Neon-Tide-v2.0.0.zip`

**Interfaces:**
- Produces release artifact with `index.html` at ZIP root and relative asset URLs.

- [ ] **Step 1: Add detailed results**

Show score, high score, max combo, near misses, breaks and rank. Victory and defeat copy must identify the actual final objective.

- [ ] **Step 2: Run automated checks**

Run: `npm test && npm run build`

Expected: tests pass and Vite exits 0 without missing imports.

- [ ] **Step 3: Run static hosting checks**

Serve `dist`, request `/`, the hashed JS and hashed CSS, and require HTTP 200. Inspect `dist/index.html` for `./assets/` URLs.

- [ ] **Step 4: Run headless browser smoke tests**

Open the built menu and an auto-start smoke session in Chrome. Require no console errors, a WebGL canvas, visible HUD, functional start/pause/resume, and responsive screenshots at desktop and mobile sizes.

- [ ] **Step 5: Package the release**

Create `Neon-Tide-v2.0.0.zip` from the contents of `dist`, not its parent directory. Verify the ZIP contains root `index.html` and all referenced assets.

## Plan Self-Review

- Spec coverage: all design sections map to Tasks 1–8.
- Placeholder scan: no TBD/TODO or unspecified implementation step remains.
- Interface consistency: IDs, exports, modes and semantic audio event names are defined once and reused consistently.
- Scope: one browser-game vertical slice; no networking, accounts or permanent progression.
