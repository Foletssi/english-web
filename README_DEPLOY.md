# ZoSpeak 可部署静态版

这是纯静态站点，无需 Node 构建即可上线。

## 本地预览
在本目录运行：

```bash
python -m http.server 8080
```

然后访问 `http://localhost:8080`。

## Vercel
将整个 ZoSpeak 文件夹导入 Vercel；Framework Preset 选择 **Other**，无需 Build Command，Output Directory 使用 `.`。

## Netlify
直接拖拽整个文件夹或 ZIP 到 Netlify Deploys 即可。`netlify.toml` 已包含静态发布配置。

## GitHub Pages
将本目录内容放到仓库根目录并开启 GitHub Pages（Deploy from branch）。项目使用 `#/...` 哈希路由，所以 Pages 刷新不会出现子路由 404。

## 目录结构
- `index.html`
- `assets/css/app.css`
- `assets/js/app.js`
- `assets/images/*`
- `assets/video/sample_lesson.mp4`
- `vercel.json`
- `netlify.toml`
- `_redirects`
- `.nojekyll`
