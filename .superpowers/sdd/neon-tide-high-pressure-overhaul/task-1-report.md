# Task 1 报告：战斗参数与可测试导演基础

## 状态

已完成。未修改 `main.js`，保留既有 gameplay helper 导出与运行时敌人 id（`chaser`、`elite` 等），并补充 2.1 高压战斗所需角色别名与配置。

## 实现摘要

- `src/game/config.js`
  - 阶段边界更新为 `[0, 30, 64, 100]`，Boss 窗口 `26s`，总局 `126s`。
  - 集中导出 `COMBAT`：桌面敌人上限 36、粗指针上限 28、粒子 300、拖尾 48、生成间隔目标、下限与 telegraph/组合冷却范围。
  - `GAME.maxEnemies` 保持为桌面上限并新增设备上限字段，兼容现有调用方。
  - 补充 Hunter、Lancer、Swarm、Bulwark 等角色数据；既有 `chaser`/`elite` 保持兼容并映射到新角色语义。
  - 新增 `FORMATION_TEMPLATES`（pincer、crossfire、mine-wall、spiral、elite-escort），每个模板声明 enemyCost、minSafeGap、cooldown、palette、roles。
- `src/game/director.js`
  - 新增无 DOM/Three.js 依赖的纯函数：`getStageIndex`、`getStageProgress`、`getActiveEnemyCap`、`getSpawnInterval`、`getFormationBudget`、`chooseFormation`、`getFormationSlots`。
  - 组合选择在冷却、预算不足或安全间隙不足时返回 `null`；排除上一模板并按 seed 稳定选择。
  - 槽位生成使用固定几何布局，保留中心安全间隙并返回角色标记。
- 测试
  - 更新 `tests/gameplay.test.mjs` 锁定新阶段边界与敌人上限。
  - 新增 `tests/director.test.mjs` 覆盖阶段/时长、设备上限、生成间隔下限、组合预算/冷却/安全间隙、确定性选择与槽位安全间隙。

## TDD 记录

先运行：

```text
node --test tests/director.test.mjs
→ ERR_MODULE_NOT_FOUND: src/game/director.js（预期红灯）
```

完成最小实现后运行：

```text
node --test tests/director.test.mjs
→ 6 tests passed
npm test
→ 14 tests passed, 0 failed
```

（本项目使用 `.runtime/node-v22.14.0-darwin-arm64/bin` 运行时。）

## Commit

见本任务提交的 commit hash。

## 潜在风险 / Concerns

- `main.js` 尚未接入 director；后续 Task 2 需要将其生成调度切换到这些纯函数，并按 `coarsePointer`/视口传入设备上限。
- `getFormationSlots` 返回的是世界坐标布局，接入时需按当前相机/arena 尺寸做尺度映射。
- `GAME.version` 按 brief 约束保持 `2.0.0`，版本号由发布任务统一更新。
