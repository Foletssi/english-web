# Eastudy Cloud Worker

该进程在本机领取 Supabase 持久任务，使用 FFmpeg、faster-whisper 和 DeepSeek 处理 R2 原片，再把 HLS、封面和学习数据写回云端。网页可以关闭；处理期间电脑和此进程需要保持运行，处理完成后的学生播放不依赖本机。

环境变量：`EASTUDY_WORKER_SECRET`（必需）、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`AI_DEEPSEEK_TRANSLATE_MODEL`。可选：`EASTUDY_ASR_DEVICE`、`EASTUDY_ASR_COMPUTE`、`EASTUDY_WORKER_ID`。

双击 `START_EASTUDY_CLOUD_WORKER.vbs` 可隐藏启动；旧 `.bat` 入口也会转交隐藏启动器，不再安装依赖或保留 CMD 窗口。Whisper 模型必须已安装，服务不会在后台静默安装依赖。

运行 `powershell -NoProfile -ExecutionPolicy Bypass -File services/cloud-worker/install-autostart.ps1` 安装/更新计划任务（保留原任务XML备份）。用户登录后自动启动，每分钟补启动已停止的进程，单实例运行，使用普通用户权限。启动器和FFmpeg均隐藏窗口。

后台每15秒领取云端任务，网络请求失败后20秒重试；网页、Codex可关闭。电脑关机、休眠、未登录或断网时无法处理，恢复登录联网后自动领取云端队列。网页不能越过浏览器限制启动关机电脑。人工停用请在Windows任务计划程序中禁用 `Eastudy Cloud Worker`，仅结束进程会被自动恢复。

日志：`tmp/cloud-worker-runtime/worker.log`、`worker-error.log`，每次重启保留旧日志。工作缓存位于 `%LOCALAPPDATA%/Eastudy/processing-jobs`，为断点续跑保留，不会自动清理原片或旧R2对象。

## 单档媒体配置

`services/local-studio/media_tools.py` 是本地导入与云端队列共用的唯一编码配置：`balanced-540-v1`，H.264 CRF25、medium、maxrate800k、最高30fps、AAC96k、4秒HLS。长边≤960、短边≤540；小原片不放大，只发布一个540p路径；≤30fps保留，高帧率整数分频至≤30。旧参数缓存不会被当作新成品复用。

## 现有视频媒体替换（维护命令）

`reencode-existing.py --original-job <已发布原任务UUID> --output <独立输出目录>` 仅本地转码并完整解码验证；加 `--apply` 才上传并原子切换线上播放。需要临时进程环境 `SUPABASE_SERVICE_ROLE_KEY` 与已有 `EASTUDY_WORKER_SECRET`，禁止把密钥写入命令参数或文件。

维护任务不重新调用Whisper/DeepSeek；字幕、词卡、学习记录和发布状态保持不变。新媒体写入独立任务/run目录，逐项回执验证后切换；旧文件保留回滚，不能把成品变小误报为R2总占用已经下降。失败应修复原因后重新运行维护命令，不使用普通解析任务重试入口。
