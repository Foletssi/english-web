# Eastudy 本地智能处理服务

## 新手启动方式

回到项目根目录，双击 `START_EASTUDY_STUDIO_V2.bat`。它会同时启动：

- 管理网页：`http://127.0.0.1:8080/admin/`
- 本地智能处理服务：`http://127.0.0.1:8788/health`

上传完成后可以关闭 Chrome 页面，但要保留标题含“Eastudy Studio Worker”的窗口；转码、英文语音识别和 AI 处理会继续执行。

## 本地数据

- 任务：`local-data/studio/jobs/`
- 原视频和自定义封面：`local-data/studio/sources/{任务ID}/`
- HLS、自动封面和临时音轨：`local-data/studio/media/{任务ID}/`

`local-data/` 已加入 `.gitignore`，不会提交视频、AI 结果或密钥。

## 真实处理链

1. `ffprobe` 验证视频、音轨、时长和分辨率。
2. `ffmpeg` 只生成一档最高 720p 的 HLS；低于 720p 的源文件保持原尺寸，不做无意义放大。
3. `faster-whisper` 生成英文字幕和词级时间轴。
4. 管理端配置的 OpenAI/DeepSeek 兼容接口生成中文翻译、重点表达、语法、难度、分类、目标映射和中文简介。
5. 严格校验字幕、AI JSON、证据 ID 和分类枚举。
6. 状态进入“待审核”；逐句人工确认完成后才允许发布。

首次使用 ASR 模型时会下载模型文件，所需时间取决于网络。AI Key 仅随上传请求发送到 `127.0.0.1` 并保存在当前 Worker 内存，不写入任务 JSON 和 Git。

## 开发验证

```powershell
py -3.14 -m unittest discover -s services/local-studio -p 'test_*.py' -v
```
