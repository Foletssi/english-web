# Processing clean break: R2 control plane

视频处理运行态切换到 Cloudflare R2 的版本化控制清单：`__eastudy/control/v1/index.json` 保存索引，`__eastudy/control/v1/jobs/<jobId>.json` 保存 Job、Run、租约、阶段、进度、错误、结果、哈希和上传回执，`jobs/<jobId>/runs/<runId>/<path>` 保存处理产物。

Supabase 仅用于登录、用户资料和管理员身份校验。浏览器调用 `/api/admin/processing-control`，Worker 调用 `/api/processing/control`；Worker 密钥只存在 Pages Secret 和本机 Worker 环境。

旧 Job 已按 Job ID 幂等导入 R2，迁移过程不会重复创建任务、重复调用 DeepSeek 或删除 R2 对象。一次性迁移入口已从生产代码和部署配置移除；当前 Worker 只使用 `https://english-web-lce.pages.dev/api/processing/control`，新任务不会回退到 Supabase Edge Worker。

验收必须检查新任务领取、心跳续租、阶段推进、重复哈希复用、同一 Run 回执、失败重试和 `output_run_id === run_id`。部署不会自动发布内容，也不会物理删除 R2 对象。
