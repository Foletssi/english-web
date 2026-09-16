# beta6.47.0 — 永久删除恢复与视频处理可靠性

日期：2026-09-17。基于 main b953d725829d90c6ce0459cc8f3b60c45f618af0；仅覆盖 M07、M08、M10 与对应公开契约消费者。

## 行为变更

- 回收站检查真实删除能力，显示中文不可用原因；取消后按钮恢复；失败任务可继续原确认范围的清理。
- 退出与跨页导航使旧轮询失效；网络超时不再被误报为未接受删除。
- 上传窗口重开保留已上传源文件与幂等键；节点健康检查有 8 秒超时。
- 普通处理及教学 v4/v5 回传必须拥有当前任务；人工重试恢复预算，旧任务不能覆盖新任务。
- 成品通过持久 multipart 回执协调删除；删除先终止在途上传，再重新枚举独占文件。已确认删除的独占源禁止新增引用，共享原片保留。

## 发布门禁与迁移

完整 scripts/test-release.ps1 已通过；专项 test:m08、test:m10、test:m04、test:mapping、test:mapping-ui、删除恢复、真实 Chrome 模拟 UI、PostgreSQL 隔离事务测试已通过。

官方 Supabase CLI 已应用并核验：

- 20260917120000_video_deletion_recovery.sql
- 20260917121000_processing_ownership_and_output_fence.sql

部署前回收站 14 条、删除任务 0 条、活动处理任务 0 条、在途成品回执 0 条。没有物理删除任何真实媒体。

## 生产配置及验收顺序

Chrome 连接器拒绝 apikey，按用户授权采用官方 Supabase CLI → Git main 推送 → Cloudflare Pages 连接 Git 构建 → HTTPS 验收。

Cloudflare 项目 english-web，域名 english-web-lce.pages.dev，VIDEO_BUCKET 绑定 eastudy-videos。保留已有播放与服务端凭据，补齐 SUPABASE_URL 和服务端 DELETION_WORKER_SECRET，安装每分钟执行的 eastudy-video-deletion 定时任务。

先关闭 VIDEO_DELETION_ENABLED 发布保护代码；验证版本与接口后再启用并重新部署配置。验证实际调度返回 HTTP 200 / IDLE、未登录接口拒绝访问、管理与学生资源内容一致；验收不创建真实删除任务。最终部署与 HTTP 结果另存本地上线验收回执，避免将发布前计划当成已成功结果。

## Standards

独立 code-review：0 项硬性违反，1 项非阻断的既有共享源判定重复建议。

## Spec

旧教学 v4 所有权绕过已修复；复核后本轮范围剩余确定性缺陷 0 项。R2 故障恢复使用模拟测试，未真实故障注入；未单独穷举 LEARNING_REPAIR 有效回传路径，不承诺全站零 Bug。

发生异常时先关闭删除开关并部署使其生效，保留数据库回执和审计结构，使用前向修复；不得回退为绕过上传保护的旧实现。
