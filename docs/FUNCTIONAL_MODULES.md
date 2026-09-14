# Eastudy 功能板块边界

本文件是后续修改的所有权地图。页面可以组合多个板块，但板块之间只能通过“公开契约”通信；不得跨板块读取私有表、复制鉴权逻辑或直接修改另一个板块的状态。当前大文件采用 expand–contract 渐进拆分，新增逻辑先进入所属共享模块，旧入口在契约稳定后收缩。

| 编号 | 使用者功能 | 主要职责 | 公开契约 | 允许依赖 | 禁止依赖 |
| --- | --- | --- | --- | --- | --- |
| M01 | 身份、账号与会员准入 | 账号规范化、登录、邀请码注册/续期、角色和 VIP 门禁、会话失效 | `learner-auth`、`invite-register`、`get_my_learning_access_v2`、`EastudyAuth`、`EastudyAccessGuard` | Supabase Auth、会员表 | 媒体对象键、处理任务内部状态 |
| M02 | 学员首页与推荐 | 首页内容、热门标签、继续学习、创作者推荐 | `EastudyCatalog`、已发布内容快照、学习摘要 | M03、M05、M06 | 草稿、处理任务、管理端私有表 |
| M03 | 内容目录与搜索 | 视频、合集、创作者、标签、难度的只读目录和筛选 | `get_published_content`、`EastudyCatalog` | M01 的准入结果 | Auth 身份解析、R2 原片 |
| M04 | 视频学习教室 | 540P 播放（过渡兼容720P）、字幕、单句循环、重点词、词卡和观看记录 | `/api/session` 短票据、媒体路由、`EastudyMediaPlayer` | M01、M03、M05 | Supabase access token Cookie、任意任务/路径 |
| M05 | 学习计划与进度 | 目标、学习时长、连续学习、历史和跨设备同步 | 学习 RPC、`EastudyData` 学习方法 | M01、M03 | 管理端草稿、处理节点租约 |
| M06 | 生词、收藏与关注 | 生词复习、句子/合集收藏、创作者关注 | 个人学习 RPC、受用户 ID 约束的本地缓存 | M01、M03 | 其他用户数据、管理端写接口 |
| M07 | 管理端内容运营 | 视频/字幕/合集/创作者编辑、发布、回收站 | 管理端内容 RPC、持久删除流程 | M01 管理员权限、M03 | 绕过回收站直接删除 R2 |
| M08 | AI 视频处理 | 上传、540P、faster-whisper、DeepSeek、续跑、回传和按视频汇总 | 处理任务 RPC、`admin_list_processing_video_groups_v1` | M07 的视频 ID、处理 Worker | 学员 UI 状态、先按任务截断再分组 |
| M09 | 学员、VIP 与邀请码管理 | 学员列表/详情、到期时间、邀请码生成复制撤销和续期 | 管理端学员/邀请码 RPC | M01 管理员权限 | 客户端明文密码、完整令牌日志 |
| M10 | 系统运营与质量 | 健康状态、审计、版本、北京时间相对时间、专项回归 | `EastudyRelativeTime`、`audit/` 测试命令 | 各板块的公开只读状态 | 直接改业务数据来制造健康结果 |

## 变更规则

1. 先确定故障归属的一个主板块；只修改该板块及其明确依赖的公开契约。
2. 修改共享契约时，必须补契约测试，并运行所有消费者板块的专项测试。
3. M01 是唯一的学习准入裁决来源；M04 只消费裁决结果，不能自行推断 VIP。
4. M04 的播放票据必须绑定 `sub/job/prefix/exp`；媒体路由不得接收完整 Supabase access token Cookie。
5. M08 必须先筛选有效视频、按视频分页，再返回该页任务；一张用户卡对应一个视频。
6. 已执行迁移不得修改；数据库修复只能新增前向迁移。永久删除媒体必须走 M07 的 durable deletion 流程。

## 专项测试入口

- M01：`npm run test:m01`
- M04：`npm run test:m04`
- M08：`npm run test:m08`
- M10：`npm run test:m10`
- 边界：`npm run test:module-boundaries`
- 全量：`npm run test:all`

当前 `assets/js/app.js` 和 `admin/assets/admin.js` 仍是组合层；它们只能编排公开契约。新领域逻辑不得继续复制进组合层。后续每次只扩出正在修改板块的模块，不为“拆文件”一次性重写全站。
