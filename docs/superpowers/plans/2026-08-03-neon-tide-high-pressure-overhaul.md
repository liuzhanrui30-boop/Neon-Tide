# Neon Tide 2.1 高压战斗与精致视觉升级实施计划

> **执行方式：** 使用 subagent-driven-development 分解可独立验证的垂直切片；每个切片完成后运行对应测试，再进入下一切片。  
> **目标版本：** 2.1.0  
> **基线：** 2.0.0，保留移动/键鼠输入、冲刺、收集、暂停与可访问性行为。

## 1. 战斗参数与可测试导演基础

**文件：**
- 修改 src/game/config.js
- 新建 src/game/director.js
- 修改 tests/gameplay.test.mjs
- 新建 tests/director.test.mjs

**实现：**
- 将阶段边界改为 [0, 30, 64, 100]，Boss 窗口 26 秒，总局 126 秒。
- 将桌面/粗指针敌人上限、粒子/拖尾上限、生成间隔、组合预算和 telegraph 时长集中为常量。
- 增加 Lancer、Swarm 与组合模板数据，模板包含 enemyCost、minSafeGap、cooldown、palette、roles。
- 在 director.js 放置纯函数：阶段解析、按设备选择上限、随阶段/时间的生成间隔、敌人预算、组合模板选择、模板槽位计算。函数不得依赖 DOM 或 Three.js。
- 用测试锁定阶段边界、总时长、设备上限、速度/间隔提升、组合冷却和不超预算行为。

**验收：** npm test 通过；纯导演函数可以在浏览器外重复运行并产出稳定的组合序列。

## 2. 高密度生成与新敌人行为

**文件：**
- 修改 src/main.js
- 修改 src/game/gameplay.js（仅添加可复用的向量/轨迹计算，保持纯函数边界）
- 修改 tests/browser-matrix.mjs

**实现：**
- 把单体 spawnEnemy() 调度替换为 director 事件：每 5–9 秒生成 pincer/crossfire/mine-wall/spiral/elite-escort，并在首领前保留至少一条可读安全缝。
- 普通生成间隔收敛到 0.72/0.55/0.42 秒目标，单帧可生成多个轻型敌人但不能突破设备预算。
- Hunter 增加追踪、侧切、短冲三态及浅青预测弧/三段尾迹。
- Striker 默认成对交叉进入，提升追踪与冲刺速度，保留 0.55 秒可读预警。
- 新增 Lancer：先锁定直线、线宽渐增、0.7 秒持续伤害光束；光束对象复用几何，不在每帧创建资源。
- 新增 Swarm：3–5 个低生命双翼棱体，同向进入后分翼，冲刺击破时触发小链式反馈。
- Mine 支持双雷/雷墙与三段扩张环；Elite 加入 4 秒一次的近距冲击波。
- 所有新攻击写入统一的 telegraph/active/cleanup 生命周期，死亡、重开、暂停和场景清理均可回收。

**验收：** 浏览器脚本在前 30 秒观察到至少三类行为和两次组合事件；桌面与粗指针运行都不超过各自敌人/粒子预算。

## 3. 关卡时长与 Boss 二阶段

**文件：**
- 修改 src/main.js
- 修改 src/game/config.js
- 修改 tests/browser-matrix.mjs

**实现：**
- 阶段时间分别扩展至 30/34/36 秒，Boss 战 26 秒；HUD 阶段刻度与剩余时间同步。
- Boss 第一阶段加入锁定冲撞、双脉冲、蜂群召唤；生命低于 50% 转入第二阶段。
- Boss 二阶段加入横扫光束、三角脉冲、两侧蜂群夹击；每种高伤害行为提前至少 0.68 秒预警，不依赖随机闪烁。
- 为 Boss 攻击增加阶段状态、攻击日志和安全窗口统计，保证完整流程结束后没有遗留 hazard/entity。

**验收：** 自动跑完整 Boss 流程，确认二阶段可达、计时稳定、暂停/恢复不跳时、结束后资源为零。

## 4. 精致霓虹海战视觉与反馈

**文件：**
- 修改 src/main.js
- 修改 src/style.css
- 修改 index.html
- 新建 src/game/render-quality.js（设备质量档位与可选后处理）

**实现：**
- 以“楔形船体＋分离翼面＋椭圆动力核＋三段尾焰”重做玩家视觉；为 Hunter/Striker/Lancer/Swarm/Mine/Elite/Boss 使用不同几何轮廓与内芯/外壳/halo 层级。
- 背景改为三层不同速度的流体线、雾光和微粒；攻击预警采用形状、方向、颜色和进度表达，不用无意义随机装饰。
- 增加命中白核、短暂冲击环、拖尾、拾取吸附与危险色阶；统一青/金/洋红/橙/红意图。
- 新增桌面端轻量 Bloom（仅高质量档位）并在移动/粗指针/减少动态时使用 halo/CSS 降级；resize、暂停和 dispose 都有生命周期处理。
- HUD 增加阶段刻度、组合事件短标签、细分隔线、等宽数字和可读的状态颜色；不遮挡玩家、Boss 与攻击预警。

**验收：** 桌面与移动截图可区分全部角色；减少动态偏好关闭强闪与镜头抖动；低质量设备没有 Composer 开销。

## 5. 性能、可访问性与回归防护

**文件：**
- 修改 src/main.js
- 修改 src/style.css
- 修改 tests/gameplay.test.mjs
- 修改 tests/browser-matrix.mjs

**实现：**
- 复用几何/材质、池化 beam/particle/trail、限制每帧临时对象；在设备档位下动态压缩组合预算而不缩短关卡时长。
- 保持键盘、触屏、暂停焦点、aria-live 状态、减少动态和低帧率墙钟行为；新增 Lancer/Swarm 说明文本与颜色以外的形状提示。
- 增加 debug 统计（仅测试暴露）：当前敌人/粒子/拖尾峰值、组合计数、Boss 阶段、清理计数；不添加作弊入口。
- 以测试覆盖 hazard 生命周期、重开清理、玩家碰撞、设备上限与无 NaN/无孤儿对象。

**验收：** npm test、浏览器矩阵桌面/粗指针/减少动态/低 FPS 全通过，npm run build 无错误。

## 6. 发布验证与交付

**文件：**
- 修改 package.json 与 package-lock.json 到 2.1.0
- 更新 docs/playtest/2026-08-03-neon-tide-hardness-report.md 添加实际结果
- 新建 docs/releases/Neon-Tide-v2.1.0-release-notes.md

**实现：**
- 运行单元测试、构建、静态产物检查和浏览器矩阵；用当前开发服务器进行实际操作试玩（开局、冲刺、暂停、移动、Boss 二阶段）。
- 生成 Neon-Tide-v2.1.0.zip，包含 dist、index.html、package.json、README.md 和必要源文件。
- 记录构建时间、测试结果、压缩包 SHA-256 与已知的 bundle warning。

**验收：** 交付可直接双击/静态托管的 zip，并明确说明已完成的难度、玩法、时长、美术和性能升级。

