# Eastudy 固定部署通道

以后所有生产部署固定采用以下链路：

1. 通过 Codex 的 `mcp__cua_repl.js` 接管用户已登录的 Google Chrome。
2. 在 Supabase SQL Editor 执行当前版本迁移并查询验证表与 RPC。
3. 仅在迁移成功后，使用 Git 将功能分支快进合并到 `main` 并推送 GitHub。
4. 等待 GitHub 触发 Cloudflare Pages 自动构建。
5. 仍使用同一 Chrome 通道验证学生端、管理端、版本号与控制台错误。

禁止使用 Windows 桌面回退控制、Codex 内置浏览器、`@oai/sky`、CDP 或 `browser-client.mjs` 代替上述链路。

