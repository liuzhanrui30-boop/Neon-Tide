# Task 5 — 性能、可访问性与回归防护报告

## 交付范围

- **有限值防护**：渲染帧入口与出口校正 NaN/Infinity 的计时器、玩家向量、敌人位置/速度/生命值；孤儿实体会被标记并清理，不把坏值继续传播到 Three.js transform。
- **容量兜底**：敌人继续由桌面 36 / 粗指针 28 cap 保护；粒子 300、拖尾 48 采用池并在 burst/guard 双重限额；涟漪与浮字增加轻量上限，避免异常反馈造成 DOM/材质堆积。
- **生命周期**：`setupInput()` 具备幂等保护，监听器可集中解绑；Composer 在质量切换时先 dispose，再创建一次新的实例，resize 只调整既有实例；重开仍沿用同一批 geometry/material/pool。
- `createParticlePool()` / `createTrailPool()` 也具备幂等保护，重复调用不会新增 geometry/material 或突破 300/48 池容量。
- **无障碍与跨平台**：键盘、触屏摇杆、冲刺、暂停/恢复、canvas 聚焦、ARIA live/进度语义与 reduced-motion 行为保持；低帧率使用 wall-clock 推进、simulation delta 仍有上限。

## 新增回归覆盖

`tests/gameplay.test.mjs` 新增 `finiteOr`、`clampFinite`、`capActiveCount` 的 NaN/Infinity/边界断言。

`tests/browser-matrix.mjs` 新增 runtime guard scenario，覆盖：

1. 重复调用 `setupInput()` 不复制监听器；
2. 注入 NaN/Infinity 后有限值恢复、孤儿敌人清理、spawn 的 Infinity sentinel 保留；
3. 粒子/拖尾仍不超过 300/48；
4. 损坏材质、Transform、速度和生命期的粒子会安全退役；
5. desktop → reduced-motion → desktop 正确 dispose/recreate，resize 不重复创建 Composer；
6. 首次请求超量池时仍被截断至粒子 300、拖尾 48。

## 验证

- 最终分支 `npm test`：25/25 通过。
- `node --check src/main.js`：通过。
- `npm run build`：通过；仅保留既有 bundle size warning。
- Browser matrix：Chrome 146，13/13 通过，覆盖 desktop/coarse/reduced-motion、光束宽度、画质切换、运行时异常恢复、Boss 二阶段与全终局清理。

## 关注项

- Composer 桌面路径仍是可选高质量分支；移动、窄屏、reduced-motion 不分配 post-processing render targets。
- 发布任务已将包版本提升为 `2.1.0`。
