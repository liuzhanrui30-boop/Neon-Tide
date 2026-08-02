# Task 1 Report — 数据模型与纯玩法计算

## 完成内容
- 新增 `src/game/config.js`：冻结的 GAME、STAGES、ENEMY_TYPES、UPGRADES 及奖励/评级阈值配置。
- 新增 `src/game/gameplay.js`：阶段边界、带低生命减压的生成预算、带组合上限的奖励、评级和注入随机源的唯一模块抽取。
- 新增 `tests/gameplay.test.mjs`：覆盖 0/18/38/53 秒阶段边界、生命减压、组合奖励上限、确定性唯一升级和 S/A/B/C 评级。
- 更新 `package.json`：版本 2.0.0，增加 `test` 与 `check` 脚本。

## 验证
- `npm test`：5/5 通过。
- `npm run check`：测试与 Vite 构建均通过（仅有现有包体积提示）。

## 关注点
- 生成预算与奖励数值为本任务依据简报建立的可调平衡常量；后续运行时应通过这些纯函数消费，避免复制数值。
