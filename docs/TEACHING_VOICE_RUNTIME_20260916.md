# 教学发音运行与验收说明

日期：2026-09-16。本文件记录本地实现与实测，不能替代线上或真手机验收。

## 运行方式

云端 Worker 调用 `services/local-studio/voice_runtime.py`，使用独立 Python 虚拟环境运行 `teaching_voice.py`。Windows 子进程与 FFmpeg 均隐藏控制台。默认解释器在项目 `tmp/voice-venv/Scripts/python.exe`，可用 `EASTUDY_VOICE_PYTHON` 指定部署机器路径。禁止提交虚拟环境、模型或私有任务输出。

依赖精确版本在 `services/local-studio/requirements-voice.txt`。模型默认在用户目录 `.cache/eastudy-kokoro-v1.0/`，可用 `ZOSPEAK_TTS_MODEL_PATH` 和 `ZOSPEAK_TTS_VOICES_PATH` 覆盖。中文路径下的 eSpeak 数据自动复制到 `%LOCALAPPDATA%/Eastudy/voice-runtime/`，避免原生库无法识别数据目录。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| kokoro-v1.0.int8.onnx | 114119327 | ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c |
| voices-v1.0.bin | 28214398 | bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d |

模型来源：[kokoro-onnx 官方 model-files-v1.1](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1)。独立环境本机文件合计约 136 MiB，另计上述模型与音色。学生端只按需请求短 MP3，不下载模型。

## 任务与发布契约

- 每个可点单词及非删除/非拒绝短语生成一条映射；词卡必须先有与原文、textRevision 对齐的语境释义和读音提示。短语整体生成，不能拼接单词录音。
- 文件指纹绑定文本、读音、语境义、模型哈希、音色和版本。资源身份额外绑定 videoId、contentRevision、sentenceId、tokenId/expressionId。重复文件只上传一次，多个合法身份各自登记。
- 生成初次失败后最多重试两次。每项 stderr JSON 进度用于管理端实际已处理数量。任务取消/租约失效会终止生成；默认 180 秒无任何项进度或 6 小时总时限报错，保留已完成文件供重试。
- 全部发音完成、文件格式及哈希检查通过后才上传并登记回执；任何项失败都不能提交本次不完整结果。已有已发布内容不会因候选失败而变空。
- 正常任务写 `video.voiceManifest`，教学修复写 `result.voiceManifest`；修复只上传发音，不重新下载或转码视频。服务端检查源版本与每个上传回执后登记授权映射。
- 输出为 24kHz 单声道 48kbps MP3，0.08–30 秒；生成时拒绝非有限/静音波形，验证 FFprobe 元数据及 FFmpeg 完整解码。
- `teachingVoiceV1` 能力来自真实最小推理与文件验证，不能只以已安装 Python 包或存在模型文件宣称就绪。

## 本地实测

2026-09-16，在 i7-12700H 上，固定 ONNX 4 个内部线程、1 个外部线程，五条语境映射（四个不同文件）冷生成约 17.6 秒。重复缓存复用约 0.84 秒。四个样例为 meticulous、figure out、read 现在时和过去时，文件约 3.8–7.3 KB，全部通过解码检查。独立 Worker CLI 最小探针真实成功，ready 音频为 4,988 字节。

这些是小样本，不代表全视频处理速度。逐语境普通词数量多时可能耗时较长；管理端应展示实际项数，不能伪造倒计时。自动解码不等于真人音质试听，真手机播放、多音词听感仍需发布验收。当前选用 `af_heart`；官方音色说明提示极短句可能与长句质量不同。

## 费用和许可证

无需另加 TTS API 密钥或按字收费的第三方服务；仍有本机算力、对象存储和流量成本。不能描述为全部免费或零配置。

- [Kokoro 模型](https://huggingface.co/hexgrad/Kokoro-82M/raw/main/README.md)与模型音色资源：Apache-2.0。
- [kokoro-onnx](https://raw.githubusercontent.com/thewh1teagle/kokoro-onnx/main/LICENSE)：MIT。
- [espeakng-loader](https://raw.githubusercontent.com/thewh1teagle/espeakng-loader/main/LICENSE)包装器：MIT；其附带 [eSpeak NG](https://raw.githubusercontent.com/espeak-ng/espeak-ng/master/COPYING)：GPLv3。
- phonemizer：GPLv3。不能把整个环境统称 Apache 或 MIT；如果之后分发安装包或运行时，应一起处理各依赖的许可证、通知及适用的源码提供义务。本次模型与环境仅用于处理端运行，不进入网页公开包。
- [音色资料](https://huggingface.co/hexgrad/Kokoro-82M/raw/main/VOICES.md)供试听与质量选择参考。

## 运维检查

```powershell
python services/cloud-worker/worker.py --check
# 需在原 Worker 环境变量已加载的终端运行；不要打印 API 密钥。
python -m unittest discover -s services/local-studio -p test_teaching_voice.py
python -m unittest discover -s services/local-studio -p test_voice_runtime.py
python -m unittest discover -s services/cloud-worker -p test_worker.py
```

手工离线生成可通过 `teaching_voice.py --request <私有请求.json> --output-dir <私有输出目录> --manifest <私有清单.json>`。该命令不上传、不发布。上线仍遵守仓库迁移、代码与验证顺序；不得用删除 R2 文件作为发音刷新步骤。
