# ZoSpeak Composite V1 Alpha

这是 ZoSpeak 学员端 + 内容管理后台的第一版可运行复合工程，不是 UI Review，也不是后台孤立 Demo。

## 入口

Windows 双击 `START_ZOSPEAK_PLATFORM.bat`。

- 学员端：`http://localhost:8080/`
- 管理后台：`http://localhost:8080/admin/`

必须通过 HTTP 服务打开，不要直接双击 HTML。后台和学员端需要保持同一 Origin 才能共享 V1 内容契约。

## 本版已经跑通的闭环

1. Admin Studio 创建 / 编辑 Video。
2. Video 使用唯一数字 ID。
3. DRAFT / PROCESSING / REVIEW 内容不会自动进入学员内容列表。
4. PUBLISHED Video 通过 `shared/content-store.js` 投影到学员端。
5. Admin Subtitle Editor 修改 Sentence 后，学员端 `/video/:id` 读取同一份句子数据。
6. 每个视频拥有独立 Processing Job，不让 Worker 状态直接控制学员 UI。
7. Admin 与 Student 共用 Light / Dark 主题偏好。
8. 内置机械审计检查 DOM、静态资源、JS 语法、共享契约和关键映射。

## Admin Studio V1 页面

- Dashboard
- Videos / Video Detail
- AI Processing Queue
- Subtitle Review / Subtitle Editor
- Creators
- Collections
- Analytics + Contract Audit
- Settings

## 重要边界

本 Alpha 已经是完整可运行的“内容管理闭环验证版”，但内容数据仍保存在浏览器 localStorage。真实公网多管理员 / 多学员运营时，应把 `shared/content-store.js` 的 Repository 实现替换成服务端 API + PostgreSQL / Payload CMS；前后台的字段契约与页面不需要重做。

视频解析页面已经建立独立 Job Contract，但此 Alpha 的“推进任务”用于验证状态机，不会在浏览器里执行 yt-dlp / FFmpeg / WhisperX。真实 Worker 必须运行在服务器侧，不能直接塞进前端进程。

## 审计

```bash
python3 audit/static_audit.py
```

查看：

- `audit/AUDIT_REPORT.md`
- `audit/AUDIT_REPORT.json`
- `audit/STUDENT_ADMIN_MAPPING.json`

## Beta2 UX / Deployment Update

- Student account control now uses an anchored dropdown with My Learning, account profile, preferences, account switching and logout.
- Student preferences dialog is viewport-centered on desktop/tablet/mobile.
- Study streak card was redesigned into a compact weekly rhythm view.
- Admin Studio typography was increased for production readability.
- `START_ZOSPEAK_PLATFORM.bat` is local-only. For actual internet deployment see `README_WEB_DEPLOY.md`; the deployed admin entry is `/admin/`.


## Beta4 交互与控制端重构

- 学员端账号、主题与中英文按钮统一触控尺寸与基线；当前视频进度可直接进入对应学习页。
- 热门标签切换主页内容分类，当前发音词改为低饱和半透明青绿色高亮。
- 学员端与控制端主题独立保存：`zs:theme` 与 `zs:admin:theme`。
- 控制端界面、状态、已知视频标题支持中文化；视频进入队列时自动给出本地化标题和难度建议。
- 字幕审核采用自动词级对齐卡片，只有显著错位时才展开高级微调。
- AI 配置说明见 `README_AI_CONFIGURATION.md` 与 `.env.example`。

## Beta3 Learning Engine — 词级时间轴

- 共享 Sentence Contract 新增 `wordTimings`：每个词包含 `text`、标准化 `word`、`start` 和 `end`。
- 后台 Subtitle Editor 支持 `word@开始-结束` 人工编辑；空白时按整句时长自动生成。
- 学员端播放中同步高亮当前发音词，字幕区与当前学习句保持一致。
- 审计会校验词时间落在所属句子的起止范围内。

## Beta2 学习播放器更新

- 手机学习页改成「视频 + 模式切换 + 连续逐句学习流」。
- 主学习模式：双语 / 英文 / 挖空 / 跟读。
- 新增重点词挖空：输入答案、Enter 检查、首次错误提示、再次错误显示答案。
- 后台字幕编辑器可为每句维护 `keyWords`，学员端优先按人工重点词挖空；旧内容无重点词时自动回退到词典等级词。
- 手机端隐藏桌面专用词汇模式与 AB 控件，减少操作密度；桌面和平板保留专业学习布局。
