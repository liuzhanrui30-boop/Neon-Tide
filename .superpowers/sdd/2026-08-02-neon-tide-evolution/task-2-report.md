# Task 2 — Web Audio 音频系统

## 完成内容

- 新增 `src/game/audio.js`，提供 `NeonAudio`、`unlock()`、`setMuted()`、`setStage()`、`update()`、`event()`、`suspendBeat()` 接口。
- 音频图仅在 `unlock()`（用户手势）后创建；无 Web Audio、静音、暂停或关闭状态下安全无操作。
- 为 11 个语义事件提供单层/双层振荡器配方，每层增益限制在 0.08 以下。
- 节拍根据游戏实时与阶段间隔进行相位感知调度，每次更新最多预排一个节拍，非 playing 模式暂停。

## 验证

- `npm test`：5/5 通过
- `npm run build`：成功（Vite 仅报告既有的大 chunk 警告）

## 提交

- Commit: `b3b845f`

## 关注点

- 当前配方使用合成振荡器，无外部音频资源；实际设备音色可在后续迭代中微调。
