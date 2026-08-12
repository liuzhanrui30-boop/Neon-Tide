# Neon Tide 技术架构

## 运行时分层

```text
DOM / CSS UI
    ↑ 只读派生状态
main.js（当前 v2.2 兼容运行时与 Three.js 装配）
    ├── 输入与模式机
    ├── 固定顺序更新循环
    ├── Entity / collision / weapon / boss 生命周期
    ├── HUD 与触屏控制
    ├── Realm backgrounds / post-processing
    └── audio bridge

纯数据与纯函数模块
    ├── config.js
    ├── gameplay.js
    ├── director.js
    ├── environment.js
    ├── realms.js
    └── skill.js

副作用模块
    ├── audio.js
    ├── realm-backgrounds.js
    └── render-quality.js
```

## 模块边界

### `src/main.js`

目前是兼容层大入口，拥有运行时实体集合、模式转换、RAF、输入和渲染装配。新代码优先提取成纯函数或独立系统，不要继续增加无边界全局状态。

### 纯函数模块

输入有限对象，输出有限值/新对象，不创建 Three.js 场景对象，不访问 DOM，不读写 localStorage。它们是最适合单元测试和 AI 修改的区域。

### 音频

`NeonAudio` 拥有 AudioContext、四条总线、音乐调度和事件音效。游戏暂停/静音时音频必须安全降级，不能阻塞核心循环。

### 背景与质量

背景系统拥有自己创建的 Three.js 对象，`dispose/reset` 时释放材质、几何和纹理。质量系统根据视口和 pointer coarse 选择粒子/DPR/后处理预算。

## 更新顺序

每个可玩的 simulation step 按以下顺序执行：

1. 读取并规范化输入。
2. 计算 `wallDt` 和受暂停/慢动作影响的 `simDt`。
3. 更新玩家、冲刺、环境力。
4. 更新敌人、敌方投射物、地雷、预警和 Boss。
5. 进行碰撞与伤害归因。
6. 更新拾取、能量、奖励、连击、阶段和结算。
7. 更新背景、粒子、镜头反馈、音频和 HUD。
8. 渲染。

暂停必须冻结第 2–6 步的游戏状态；UI 的按钮响应仍然可用。

## 生命周期

```text
create runtime
  → init scene/pools/audio/input
  → start game
  → update/render
  → pause / upgrade / defeat / victory
  → reset room or restart run
  → dispose all listeners, timers, audio nodes, scene resources
```

所有对象池都必须有硬上限。对象被回收后不能继续被碰撞、音频或 HUD 引用。

## 数据流与事件

- 规则参数来自 `config.js`、`realms.js` 和 `environment.js`。
- `director.js` 只决定压力预算和编队候选，不直接生成 Three.js 对象。
- `skill.js` 只决定光矛规则，不直接操作 HUD。
- `main.js` 将规则结果应用到运行时实体，再将派生信息投影到 HUD 和音频。
- 未来拆分时优先使用事件/命令：`player:dash`, `weapon:laser-fired`, `boss:phase-changed`, `realm:changed`, `run:ended`。

## 测试策略

- 纯规则：Node `node --test tests/*.test.mjs`。
- 构建：`npm run build`，确认 hashed 资源和相对路径。
- 浏览器：`tests/browser-matrix.mjs` 使用 Chrome CDP 验证暂停、输入、重置、音频、触屏和领域截图。
- 发布：GitHub Actions 在 Ubuntu + Node 22 上重复执行测试和构建。

## 已知技术债

1. `main.js` 仍较大，后续可按输入、实体、碰撞、Boss、HUD、生命周期继续拆分。
2. Three.js 主 bundle 超过 Vite 默认 500 kB 警告阈值；功能不受影响，但可通过 manual chunks 和按领域动态加载优化。
3. 当前稳定发布是 v2.2；v3.0 Data City/Protocol Zero 设计资料已保留在历史开发分支和 `docs/superpowers/`，未宣称为稳定发布。
