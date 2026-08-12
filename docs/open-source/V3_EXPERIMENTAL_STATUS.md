# Neon Tide v3.0 实验线说明

本分支完整公开了 Neon Tide v3.0「成熟战役」实验线的源代码、规格、实施计划与测试记录，供 AI 和开发者直接阅读、拆分任务和继续迭代：

- 公共分支：`experimental/neon-tide-v30`
- 稳定可玩版本：[`main` / v2.2.0](https://liuzhanrui30-boop.github.io/Neon-Tide/)
- v3.0 设计规格：[`docs/superpowers/specs/2026-08-06-neon-tide-v30-mature-campaign-design.md`](../superpowers/specs/2026-08-06-neon-tide-v30-mature-campaign-design.md)
- v3.0 实施计划：[`docs/superpowers/plans/2026-08-06-neon-tide-v30-mature-campaign.md`](../superpowers/plans/2026-08-06-neon-tide-v30-mature-campaign.md)

## 重要边界

这是一条**实验开发线**，不是当前 GitHub Pages 的生产发布版本。v3 的章节化战役、Protocol Zero 与浏览器自然通关验收仍在迭代中；任何二次开发或发布都应先运行完整测试并自行完成浏览器验收。不要把测试辅助器的成功当成 Boss 已通关或生产稳定性的证明。

## AI 接手方式

```bash
git clone https://github.com/liuzhanrui30-boop/Neon-Tide.git
cd Neon-Tide
git switch --track origin/experimental/neon-tide-v30
npm ci
npm test
npm run build
```

推荐先阅读 `docs/superpowers/specs/` 的 v3 规格，再对照 `docs/superpowers/plans/` 的任务顺序；稳定运行时的数据契约、状态所有权和测试入口仍以 `docs/open-source/AI_HANDOFF.md` 与 `docs/architecture/TECHNICAL_ARCHITECTURE.md` 为准。

