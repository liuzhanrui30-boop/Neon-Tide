# Neon Tide v3.0 实验线说明

Neon Tide v3.0「成熟战役」实验线的完整源代码、规格、实施计划与测试记录已公开在：

- [实验源码分支 `experimental/neon-tide-v30`](https://github.com/liuzhanrui30-boop/Neon-Tide/tree/experimental/neon-tide-v30)
- [v3.0 设计规格](https://github.com/liuzhanrui30-boop/Neon-Tide/blob/experimental/neon-tide-v30/docs/superpowers/specs/2026-08-06-neon-tide-v30-mature-campaign-design.md)
- [v3.0 实施计划](https://github.com/liuzhanrui30-boop/Neon-Tide/blob/experimental/neon-tide-v30/docs/superpowers/plans/2026-08-06-neon-tide-v30-mature-campaign.md)

## 重要边界

这是一条**实验开发线**，不是当前 GitHub Pages 的生产发布版本。v3 的章节化战役、Protocol Zero 与浏览器自然通关验收仍在迭代中；任何二次开发或发布都应先运行完整测试并自行完成浏览器验收。当前稳定可玩版本仍是 [`main` / v2.2.0](https://liuzhanrui30-boop.github.io/Neon-Tide/)。

## AI 接手方式

```bash
git clone https://github.com/liuzhanrui30-boop/Neon-Tide.git
cd Neon-Tide
git switch --track origin/experimental/neon-tide-v30
npm ci
npm test
npm run build
```

推荐先阅读实验分支的 `docs/superpowers/specs/` 设计规格，再按 `docs/superpowers/plans/` 的任务顺序实施；稳定运行时的数据契约、状态所有权和测试入口仍以 `docs/open-source/AI_HANDOFF.md` 与 `docs/architecture/TECHNICAL_ARCHITECTURE.md` 为准。

