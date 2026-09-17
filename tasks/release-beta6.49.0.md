# beta6.49.0 — 本地原片自动制作

## 范围

审计基线：665c795a1ab9b74256d2eb2476f187fab28f0225（beta6.48.0）。
规格：docs/M08_LOCAL_FIRST_AUTOMATIC_PROCESSING_PLAN_20260917.md。
主模块 M08，仅调整 M07 草稿和成品上传等必要公开契约，不改变学生界面或已有视频。

选片、开始处理后，原片经本机分块接收及完整 SHA256 校验进入持久目录；绑定节点自动使用原始音轨识别、一次均衡540P编码、完整教学与发音制作，然后上传成品。默认不把原片传入云端再下载。旧云端任务保持兼容。

补齐：预约幂等和草稿 revision 同步；READY/MISSING 回执恢复；阶段依赖与 GPU 资源限制；完整媒体检查点；上传失败对账及完成幂等回执；本地来源的修复、转码与删除清单映射。磁盘不足提前阻止接收。

## 验证记录

- 发布全量脚本、模块检查及管理/学生映射测试已执行；首次浏览器映射测试端口不符，指定实际本地服务端口后通过。
- 最近 Worker Python 59 项、本地处理器 Python 132 项、M08 全部专项及本地来源消费者契约通过。
- 五个迁移在事务中配合本地恢复、提交回执、步骤控制及兼容包装夹具执行，通过后整体回滚；验证包含清理权限隔离及未完成来源保护。
- 五个正式迁移已成功应用，安装后的数据库回滚夹具再次通过；video-processing Edge 已通过官方 CLI 部署。Pages、Worker 和 HTTPS 验证结果在发布完成后追加。

## 生产发布记录（2026-09-17 20:44，北京时间）

- 应用提交 `e878c68` 已推送 main，Cloudflare Pages 已生效。学生入口 `/`、管理入口 `/admin/` 对应的 HTML，以及 studio-v2、local-processing-client、local-file-hash-worker、local-reservation、processing-control、admin、cloud-content 脚本均从生产 HTTPS 读取，与本地发布代码逐字核对一致（仅规范化 Git 的 CRLF/LF 差异）。
- `/api/processing/output` GET 未带运行票据返回 JSON `401 OUTPUT_TOKEN_INVALID`，确认新版对账路由存在；不是静态页面回退，也不是无保护地读取资源。
- 隐藏计划任务已重新启用并启动，Worker 2.5.0 正常运行。云端心跳确认 `localInputV1=true`、`mediaProfile=balanced-540-v1`。启动错误日志为空；ASR、DeepSeek、发音依赖和 FFmpeg 就绪。发音健康检查命中缓存，不能据此宣称本轮已实测 GPU 发音吞吐。
- 带正式网站 Origin 的本机 `/v2/capability` 返回 `ready=true`、协议版本 1；本机工作盘空闲约154 GiB。OPTIONS 返回204，包含正式 Origin、所需方法及本地网络响应头。错误 Origin 和无票据请求均被拒绝。
- 所有依赖就绪后启用生产 `local_input_v1=true`，SQL 返回值已确认。启动前数据库只有一项已取消任务，无活动任务；本轮没有重处理旧视频、没有上传测试原片，也没有物理删除 R2 媒体。
- 浏览器连接器的认证障碍尚未解除：以上是实际 HTTPS、进程及生产数据库检查，不代表真实 Chrome 的本地网络授权弹窗或约400MB新原片端到端制作已通过。该项保留为未完成验收，不标记“全流程正式验收通过”，也不承诺无任何 Bug。

## code-review

### Standards

前序独立审查没有阻断项；阶段名称重复映射为非阻断维护建议。末轮独立审查指出单文件测试导入路径问题，已修正并独立运行通过。后续独立增量审查因提供商余额不足失败，不能记为通过；由主代理直接检查增量的锁、路径边界、权限和启动脚本。

### Spec

前序独立审查提出磁盘占用/明确清理入口和 GPU 显存不足回退两个 P2，均已实现。原片清理首版为离线管理员工具，不是网页删除按钮；活动或失败待恢复任务不得清理。浏览器连接器拒绝当前认证方式，真实制作电脑 Chrome 的完整大文件交互仍需单列，不以契约或 HTTPS 检查替代。未完成真实新视频全流程前，不宣称该验收通过。

## 发布与回退

采用已授权的官方 Supabase CLI、Git main、Cloudflare Pages 连接仓库发布通道。
顺序：迁移及安装后夹具 → Edge → Pages → 隐藏 Worker → 健康检查 → 启用 local_input_v1。Worker 新版依赖 Pages 成品对账 GET，因此本轮先更新 Pages，再重启 Worker；开关始终等待所有依赖就绪。

本机处理目录已迁到容量充足的磁盘，2209 文件逐个 SHA256 校验一致；原目录原样保留。启动器每次读取用户环境 EASTUDY_WORK_ROOT，并将临时目录放到该盘。机器路径和凭据不写入发布文档。

清理工具：先确认节点无活动工作，停止隐藏 Worker，再运行 `py -3.12 services/cloud-worker/local_storage.py` 预览；只对明确完成的 sourceId 运行同命令加 `--source-id <UUID> --confirm`。必须具备已有 Worker 凭据；工具取得独占锁并验证云端消费者状态，仅删除应用副本，保留回执、不碰用户选片原文件。清理后的已完成任务不能原位恢复原片，需要重做时重新选片建立新任务。本轮未执行实际原片或 R2 删除。

回退先关闭 `private.processing_feature_flags` 中 local_input_v1，保留前向结构及新版 Worker 处理已接收本地任务；不让旧 Worker 领取本地输入，不静默改成云端原片上传。恢复原目录必须停在安全边界，并先同步迁移后新增文件，禁止用旧备份覆盖新任务。
