# Neon Tide 二次开发路线图

## 已完成：v2.2 稳定线

- 四领域独立背景、音乐、环境和调色。
- Hunter、Striker、Lancer、Swarm、Mine、Bulwark、Elite、Boss。
- 自动武器、潮汐光矛、冲刺无敌、拾取和强化。
- 键盘/触屏、暂停、设置、reduced motion、高对比。
- 对象池、粒子预算、资源释放和 GitHub Pages 自动发布。

## 下一阶段：v2.3 可维护性

1. 从 `main.js` 提取 `InputSystem`、`PlayerSystem`、`EnemySystem`、`CollisionSystem`。
2. 用事件总线替代跨区域直接修改。
3. 为运行时状态增加 schema 校验和开发诊断面板。
4. 为移动端加入性能采样和低端设备默认质量档。
5. 将音频调度和游戏时间统一到更清晰的时钟接口。

验收：现有 Node 测试不回退；浏览器矩阵在桌面、390×844、reduced-motion 通过。

## 中期：v3.0 内容扩展

### Data City / Protocol Zero

- Escort、Storm Corridor、Dual Crisis 三房。
- Firewall、Traffic Grid、Clone Nodes、Kernel 四阶段 Boss。
- 每个安全路线必须是玩家可见、可碰撞、可验证的世界实体，而不是 debug 字段。
- 交通墙和预测光束必须从玩家当前位置到真实目标保持连续可达路线。

### Star Forge / Solar Foundry

- 精英狩猎、核心采集、重力改变和陨石引导。
- Boss：Armor、Meteor Guide、Core、Reverse Orbit。
- 重力必须作用于所有可移动游戏实体，暂停期间不得偷偷推进。

### Void Cathedral / Void Regent

- 对称路线、仪式节点、镜像路线、崩塌终局。
- Boss 节点阶段暂时免疫本体伤害，必须先清理目标节点。
- 镜像攻击只能复制延迟路线样本，不能读取玩家未来位置。

## AI 实现顺序

```text
先读 AI_HANDOFF
→ 运行稳定线测试/构建
→ 选择一个章节或系统
→ 写失败测试
→ 修改纯数据/规则模块
→ 接入运行时
→ 加浏览器验收
→ 更新 GDD、架构和路线图
```

## 不应做的事情

- 不要把 v3.0 计划当成已完成功能。
- 不要用 debug API、直接改血量或跳过碰撞来证明玩法。
- 不要删除稳定线的暂停、输入、资源上限和无障碍契约。
- 不要用根路径资源引用破坏 GitHub Pages 子路径。
