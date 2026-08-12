# Contributing to Neon Tide

感谢参与 Neon Tide。请优先提交小而可验证的改动，并保持玩家体验、可访问性和性能预算不退化。

## 快速开始

```bash
npm ci
npm test
npm run build
npm run dev
```

## 改动规则

- 游戏规则、敌人参数、升级和章节内容放在 `src/game/` 的数据模块中，避免把平衡常数散落在 `src/main.js`。
- 新功能先添加单元测试，再修改运行时代码。
- 视觉、声音和交互改动要同时检查 reduced-motion、移动端和键盘操作。
- 不提交 `node_modules/`、`.runtime/`、`dist/`、私密 token 或本地存档。
- 提交信息使用 `feat:`, `fix:`, `docs:`, `test:`, `ci:` 前缀。

## 验收清单

```bash
npm test
npm run build
git diff --check
```

页面必须从 GitHub Pages 子路径加载，不能使用根路径资源引用。提交 PR 后，GitHub Actions 会自动执行测试和构建。
