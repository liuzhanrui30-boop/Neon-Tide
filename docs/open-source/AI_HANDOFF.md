# AI 二次开发交接说明

> 目标：让新的 AI 编码代理在阅读本文件后，可以立即定位入口、理解状态所有权、运行测试并开始安全改动。

## 1. 项目事实

- 项目：Neon Tide · 霓虹潮汐
- 类型：Three.js 2D 平面霓虹生存射击/躲避游戏
- 稳定发布线：v2.2.0
- 技术栈：Vite 7、Three.js 0.180、原生 JavaScript ES modules、Node.js 22
- 在线地址：<https://liuzhanrui30-boop.github.io/Neon-Tide/>
- 本地入口：`index.html` → `/src/main.js`

## 2. 先运行什么

```bash
npm ci
npm test
npm run build
npm run dev
```

浏览器访问 Vite 输出的地址。生产构建只发布 `dist/`；Vite `base: './'` 是 GitHub Pages 子路径部署的关键。

## 3. 目录地图

| 路径 | 责任 |
| --- | --- |
| `src/main.js` | 运行时装配、Three.js 场景、RAF、输入、实体更新、HUD 和生命周期；目前是兼容层大入口 |
| `src/game/config.js` | 战斗常数、敌人、编队、升级、奖励和版本 |
| `src/game/gameplay.js` | 纯函数：碰撞、时间、生成预算、奖励、评级、升级选择 |
| `src/game/director.js` | 敌人压力、阶段、生成间隔、编队预算和安全缺口 |
| `src/game/environment.js` | 四领域环境事件、预警/生效帧、暗流/数据车道/重力计算 |
| `src/game/realms.js` | 四领域身份、调色、音乐 BPM、环境类型和时间边界 |
| `src/game/realm-backgrounds.js` | 四领域背景、分层几何和动态地标 |
| `src/game/audio.js` | Web Audio 四总线、音乐层、事件音效和光矛音频桥 |
| `src/game/skill.js` | 潮汐光矛能量、充能阶段、窄束命中和目标选择 |
| `src/game/render-quality.js` | 桌面/移动质量选择、后处理、DPR 和资源生命周期 |
| `src/style.css` | HUD、菜单、触屏控制、四领域主题、可访问性状态 |
| `tests/*.test.mjs` | 纯逻辑和渲染/音频契约测试 |
| `tests/browser-matrix.mjs` | Chrome DevTools Protocol 浏览器验收矩阵 |
| `.github/workflows/deploy-pages.yml` | main 分支测试、构建和 GitHub Pages 发布 |

## 4. 状态所有权

- `src/main.js` 的 `state` 是当前 v2.2 运行时状态唯一写入者；输入、敌人、环境、武器、Boss 和结算都通过运行时主循环修改它。
- `src/game/*.js` 中的纯函数不保存运行时状态，输入对象后返回新值或派生值。
- `audio.js` 只拥有 Web Audio 节点和音频调度状态，不写游戏状态。
- `realm-backgrounds.js` 只拥有场景中的背景对象，不决定游戏胜负。
- HUD 只读 `state` 和派生数据，不应成为规则写入者。

## 5. 每帧顺序

1. 读取键盘/触屏输入。
2. 依据暂停和模式确定 `wallDt`、`simDt`。
3. 更新玩家移动、冲刺和环境力。
4. 更新敌人、敌方投射物、地雷和预警。
5. 处理碰撞、伤害、险闪、击破和拾取。
6. 更新阶段、Boss 窗口、光矛能量和奖励。
7. 更新背景、粒子、镜头反馈、音频和 HUD。
8. 渲染 Three.js 场景。

## 6. 扩展方式

### 添加敌人

1. 在 `src/game/config.js` 的 `ENEMY_TYPES` 添加数据。
2. 在 `src/game/director.js` 增加可选生成/编队规则。
3. 在 `src/main.js` 增加实体行为、碰撞和视觉分支。
4. 为威胁成本、阶段门槛、安全缺口和移动端上限添加测试。

### 添加升级

1. 在 `UPGRADES` 添加唯一 `id`、名称、说明和效果值。
2. 在运行时的升级效果读取处消费该 id。
3. 确认候选不重复、已拥有升级不会再次出现，并补测试。

### 添加领域

1. 在 `realms.js` 添加时间边界和主题身份。
2. 在 `environment.js` 添加环境规则和预警合同。
3. 在 `realm-backgrounds.js` 添加独特地标与清理逻辑。
4. 在 `audio.js` 增加音乐层参数。
5. 在 CSS 增加领域主题，并补四领域差异测试。

## 7. 常见陷阱

- GitHub Pages 是子路径，禁止写 `/assets/foo.js` 这类根路径资源。
- 不要把光矛做成自动无限发射：正常拾取充能，满能量后由玩家按 `E`/触屏按钮触发。
- 不要添加瞄准输入；游戏设计是移动、躲避和路线判断。
- `prefers-reduced-motion` 下不能只隐藏提示，必须保持危险物可读。
- 任何对象池、粒子、音频节点和事件监听器都要有上限和 dispose/reset 路径。
- 改动 `src/main.js` 前先确认是否可以放入现有纯函数模块，避免继续扩大大入口。

## 8. 推荐 AI 工作流

```text
阅读本文件 → npm test/build → 找到最小责任模块 → 先写失败测试
→ 单一改动 → 运行聚焦测试 → 运行全套测试 → 浏览器 smoke → 更新文档
```

回答问题时必须区分：已实现事实、设计目标、未完成计划和已知风险。不要把 `docs/superpowers/` 中的旧计划当作当前完成状态。
