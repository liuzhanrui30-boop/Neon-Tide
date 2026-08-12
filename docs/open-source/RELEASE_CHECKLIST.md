# 开源发布清单

## 源码

- [x] `src/`、`tests/`、`index.html`、构建配置公开。
- [x] MIT `LICENSE`。
- [x] `.nojekyll`。
- [x] GitHub Pages workflow。
- [x] PR 测试 workflow。

## AI 交接

- [x] `docs/open-source/AI_HANDOFF.md`
- [x] `docs/design/GAME_DESIGN_DOCUMENT.md`
- [x] `docs/architecture/TECHNICAL_ARCHITECTURE.md`
- [x] `docs/open-source/DEVELOPMENT_ROADMAP.md`
- [x] `CONTRIBUTING.md`

## 发布验证

```bash
npm ci
npm test
npm run build
git diff --check
```

GitHub Pages 发布后检查：

```bash
curl -I https://liuzhanrui30-boop.github.io/Neon-Tide/
```

然后在全新浏览器配置中打开页面，确认画布出现、菜单可交互、脚本无异常、JS/CSS hashed 资源均返回 200。
