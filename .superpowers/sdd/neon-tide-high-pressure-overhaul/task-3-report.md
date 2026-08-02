# Task 3 report — Boss 二阶段与加长终局（TDD 红灯）

## 状态

已在 Task 2 修复提交 `1862a10` 上完成 Boss runtime：二阶段状态锁存、攻击生命周期和终局清理已接入。

本次 review fix：

- 攻击结束、Boss 二阶段切换统一隐藏光束/脉冲/三角 hazard，避免残留视觉；
- 三角脉冲改用可复用三角扇区几何，碰撞按方向夹角与半径判定，不再是全圆伤害；
- 浏览器场景改为由 Boss `recover → choose → telegraph → execute` 计时推进，观察光束碰撞、三角方向安全区/命中、蜂群生成和终局清理；
- 增加浏览器 debug 对 0/30/64/100 边界、126s 总时长、100s Boss 接入与暂停冻结的断言。

## 测试变更

- 更新 `jumpToBoss` 与胜利场景，使用 0/30/64/100 边界、Boss 窗口 26 秒、总时长 126 秒。
- 新增 `boss phase two and attack cleanup` 浏览器场景：
  - 观察 HP 低于 50% 后 `state.stats.bossPhase` 与 Boss 实体 phase 一次性锁存为 2；
  - 观察横扫光束、三角脉冲、两侧蜂群三种二阶段攻击及至少 0.68 秒 telegraph；
  - 终局后确认敌人和 active hazard 清理为 0。

## 验证

- `PATH="$PWD/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH" npm test`：16/16 通过（纯逻辑测试尚未覆盖新 runtime）。
- `PATH="$PWD/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH" npm test`：20/20 通过（含 Task4 render-quality 逻辑测试）。
- `PATH="$PWD/.runtime/node-v22.14.0-darwin-arm64/bin:$PATH" npm run build`：通过；仅保留 Three.js bundle 体积提示。
- `tests/browser-matrix.mjs`：当前环境 Chrome/CDP 在页面初始化时未出现 canvas（Vite 页面加载超时），因此无法完成浏览器场景；待可用 WebGL/CDP 环境复跑。

## 下一步

实现包含：

- 第一阶段锁定冲撞、双脉冲、蜂群召唤；
- HP < 50% 一次性进入 phase 2，并在 `state.stats`/Boss 实体可观察；
- 第二阶段横扫光束、三角脉冲、两侧蜂群夹击，统一 0.68 秒 telegraph；
- Beam 碰撞、脉冲 hazard 计数，以及胜负/截止时敌人和 hazard 清零。
