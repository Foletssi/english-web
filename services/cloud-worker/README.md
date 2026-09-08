# Eastudy Cloud Worker

该进程在本机领取 Supabase 持久任务，使用 FFmpeg、faster-whisper 和 DeepSeek 处理 R2 原片，再把 HLS、封面和学习数据写回云端。网页可以关闭；处理期间电脑和此进程需要保持运行，处理完成后的学生播放不依赖本机。

环境变量：`EASTUDY_WORKER_SECRET`（必需）、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`AI_DEEPSEEK_TRANSLATE_MODEL`。可选：`EASTUDY_ASR_DEVICE`、`EASTUDY_ASR_COMPUTE`、`EASTUDY_WORKER_ID`。

运行 `START_EASTUDY_CLOUD_WORKER.bat`。首次识别会下载 Whisper 模型；任务和原片不保存在仓库，临时文件会在每个任务结束后清理。
