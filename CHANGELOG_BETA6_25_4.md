# Beta 6.25.4

- 新增 Supabase 持久视频任务表、原子租约、阶段重试、取消和迟到结果保护。
- 部署 `video-processing` Edge Function 与每分钟调度：Cloudflare Stream 负责转码/英文字幕，DeepSeek 负责逐句翻译、语法、难度、分类和简介。
- 生产批量导入改为 R2 上传后创建真实云端任务；关闭网页不会中断已入队任务。
- 线上不再保存或回读浏览器 API Key，只展示服务端配置状态。
- 视频删除先取消活动任务再进入可恢复回收站，保留 R2 原片。
- 固定操作列表格列宽和右侧吸附区，避免“删除”等按钮被视口裁切。
- 新增 VTT、AI 输出边界、任务租约、云端 RPC 和签名 R2 源文件契约测试。

上线约束：Cloudflare Stream 的 Account ID 与 Stream API Token 必须作为 Supabase Secrets 配置；缺失时管理端会明确显示“云端服务未就绪”，不会伪造处理成功。
