# Task 3 report — Boss 二阶段与加长终局（TDD 红灯）

## 状态

本轮仅提交验收测试，Boss runtime 尚未实现，故测试应保持红灯，等待 Task 2 修复波次完成后再继续实现。

## 测试变更

- 更新 `jumpToBoss` 与胜利场景，使用 0/30/64/100 边界、Boss 窗口 26 秒、总时长 126 秒。
- 新增 `boss phase two and attack cleanup` 浏览器场景：
  - 观察 HP 低于 50% 后 `state.stats.bossPhase` 与 Boss 实体 phase 一次性锁存为 2；
  - 观察横扫光束、三角脉冲、两侧蜂群三种二阶段攻击及至少 0.68 秒 telegraph；
  - 终局后确认敌人和 active hazard 清理为 0。

## 红灯验证

- `PATH="$PWD/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH" npm test`：16/16 通过（纯逻辑测试尚未覆盖新 runtime）。
- `tests/browser-matrix.mjs` 当前在页面初始化阶段超时（Vite/Chrome 页面未出现 canvas），因此无法运行到新增场景；新增断言仍会在 Boss phase2 runtime 缺失时明确失败（缺少 `bossPhase`、`bossAttackLog`、phase2 attack kinds）。

## 下一步

待 Task 2 fix 合并后，恢复 `src/main.js` 实现 Boss phase2、double pulse、phase1 swarm、攻击生命周期与终局清理，再运行完整 browser matrix、`npm test` 和 `npm run build`。
