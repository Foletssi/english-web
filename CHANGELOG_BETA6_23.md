# Eastudy Beta 6.23.0

## 已完成

- 管理端视频支持上传到 Cloudflare R2，采用 8 MiB 分片和 2 GiB 单文件上限。
- 视频读取改为登录鉴权的同源 `/api/media`，支持浏览器 Range 请求。
- 管理端草稿写入 Supabase；发布时生成仅含已发布内容的原子快照，学生端跨设备读取。
- 管理员采用 Supabase 身份与服务端管理员权限双重校验，学生端继续与管理入口隔离。
- 文案、字幕经过受控词表生成主题、场景、语言点和学习技能标签，并明确保留人工复核状态。
- 注册、登录、账户改密统一为至少 6 位；修复注册完成后的重复改密调用。
- 未配置短信供应商时，“忘记密码”不再跳入不可用的短信验证码流程，而是提示联系管理员核验后重置。
- 新增云端内容、R2 上传、媒体鉴权、发布原子性的回归审计。

## 上线依赖

1. 按顺序执行 `supabase/migrations/` 中三份现有 MVP 迁移以及 `20260908_cloud_content_and_admin.sql`。
2. 在 Cloudflare Pages 项目绑定名为 `VIDEO_BUCKET` 的 R2 存储桶。
3. 管理员账号必须同时位于 `private.admin_memberships` 且 `public.profiles.role = 'admin'`。

## 暂未包含

- WhisperX、翻译、词典和内容标签当前仍是本地规则/任务边界，尚未连接付费 AI 处理服务。
- FSRS 完整调度与各考试官方授权词库尚未接入。
