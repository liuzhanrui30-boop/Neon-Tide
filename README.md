# Neon Tide · 霓虹潮汐

一个使用 Three.js 制作的轻量 2D 俯视生存收集小游戏。

## 运行

```bash
npm install
npm run dev
```

打开终端提示的本地地址即可开始。

## 玩法

- `WASD` / 方向键：移动飞船
- `Space`：脉冲冲刺，短时间无敌
- `P` / `Esc`：暂停
- 手机/平板：左下角虚拟摇杆 + 右下角冲刺按钮
- 收集黄色光核、躲避红色追猎信号，坚持 45 秒即可通关

## 实现要点

- Three.js `OrthographicCamera` + XY 平面几何体实现 2D 画面
- 独立游戏状态：菜单、进行中、暂停、失败、胜利
- 轻量粒子池、屏幕震动、闪屏、冲刺拖尾、连击与 Web Audio 音效
- 自适应视口、DPR 上限 2、触屏输入与 `prefers-reduced-motion` 支持

这个目录独立于上级的 Godot 项目，不会修改原有场景。
