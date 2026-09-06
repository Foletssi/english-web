# ZoSpeak Web 部署说明

`START_ZOSPEAK_PLATFORM.bat` 只用于 Windows 本地预览，正式部署到互联网时 **不需要运行 BAT 文件**。

## 部署后的入口

- 学员端：`https://你的域名/`
- 管理后台：`https://你的域名/admin/`

当前 Beta1 是静态可部署构建，Student 与 Admin 同源，因此共享内容层和浏览器端契约可以正常工作。

## Vercel

1. 新建 Project。
2. 上传整个 ZoSpeak 项目目录，或把目录推到 Git 仓库后导入。
3. Framework Preset 选择 `Other`。
4. Build Command 留空。
5. Output Directory 留空或使用 `.`。
6. 部署。

项目根目录已经包含 `vercel.json`。

## Netlify

1. 新建 Site。
2. Deploy manually 或连接 Git 仓库。
3. Publish directory 设为项目根目录 `.`。
4. 不需要 Build Command。
5. 部署。

项目已经包含 `netlify.toml` 与 `_redirects`，`/admin/` 会进入管理后台。

## 自己的 Nginx / 宝塔服务器

将整个目录上传到网站根目录，例如：

```text
/www/wwwroot/zospeak/
```

Nginx 静态根目录指向该目录。确保：

- `/` 可以返回 `index.html`
- `/admin/` 可以返回 `admin/index.html`
- `/assets/`、`/shared/`、`/admin/assets/` 可作为静态文件访问

## 下一阶段正式后端

当接入 Better Auth、PostgreSQL、Payload CMS、视频 Worker 后，部署方式会升级为前端 + API + Worker + 数据库的容器/云部署。BAT 始终只会是本地开发辅助，不会成为线上启动方式。
