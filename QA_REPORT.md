# ZoSpeak Composite V1 Beta2 — QA Report

## 结果

**PASS — 24/24 静态/契约检查通过。**

共享内容运行回归：**11 tests passed**。

## 本轮专项检查

- 学员端存在 `English / Cloze` 新模式。
- 重点词挖空逻辑存在：重点词选择、输入、Enter/按钮检查、提示、答案回显。
- 后台 Subtitle Editor 可编辑每句 `keyWords` 并保存到共享 Sentence Contract。
- 手机端使用连续逐句学习流：播放器固定在顶部、模式栏位于播放区域下方、Transcript 始终作为学习正文显示。
- 手机端隐藏桌面专用 Vocabulary 模式和 AB 控件，保留单句循环 / 倍速 / 静音。
- `playsinline` 已启用，避免移动端视频不必要地强制全屏。
- JavaScript syntax：student/admin/shared 全部通过 Node `--check`。
- Student/Admin 继续读取同一共享内容层，发布状态过滤和动态 Video ID 回归通过。

## 范围说明

本轮实现的是前端可交互的重点词挖空与后台重点词编辑契约。AI 自动挑选重点词目前使用「人工 keyWords 优先 + 现有词典等级回退」，还没有接入真正的服务端 ECDICT/CEFR/LLM 批处理。
