# 雾蓝播放器本地接入与组件映射

日期：2026-09-16。交付版本：beta6.42.0。范围包括学生端播放器、主页配色、发音反馈、目录缓存和云端偏好合并；发布结果见 `tasks/release-beta6.42.0.md`。本轮不触发 AI 重处理，不删除云端视频，不改变会员准入规则。

## 1. 实现结果

采用第3套雾蓝深浅主题，保留第4版的标题、全宽视频、练习模式、滚动字幕、常驻底栏顺序；第5版盲听复用同一布局。底栏由24px进度行、44px播放控制、44px学习工具组成，另加设备底部安全区。

四种练习模式直接展开：连续播放、逐句暂停、单句循环、听写填空。盲听独立可点；字幕语言设置放在“更多”。手机端不显示音量滑块及“当前句解析”。深浅主题入口保留在标题栏。

重点词保留已有教学颜色；短语父元素整体下划线；播放状态只更新单词子元素底色，不用跨行矩形边框，也不把重点词改成黑色。此次不改教学词表、难度或 DeepSeek 生成内容。

## 2. 真实应用几何参数

适用宽度不超过850 CSS px；宽度超过850使用现有桌面布局。不是按截图像素或手机型号硬编码。

```js
const H = Math.round(window.visualViewport?.height || innerHeight);
const W = videoPage.clientWidth;
const videoHeight = Math.max(64, Math.min(W * 9 / 16, H * .42, H - 300));
const headerHeight = 44 + T; // T = env(safe-area-inset-top)
const modesHeight = 44;
const dockHeight = 112 + B; // B = env(safe-area-inset-bottom)
const dockY = H - dockHeight;
const transcriptY = headerHeight + videoHeight + modesHeight;
const transcriptHeight = dockY - transcriptY;
```

`app.js/updateMobilePlayerGeometry()`设置视口和视频高度 CSS 变量；CSS Grid 计算剩余字幕空间。字幕自行滚动，底栏不覆盖字幕。安全区取浏览器实际值，不固定增加34px，也不绘制假的系统状态栏。

正常手机竖屏视频框为全宽16:9；平板或低视口触发限高以保留字幕空间。素材始终 `object-fit:contain`，不裁切、拉伸；非16:9素材可能有必要的黑边。

390×844，顶部安全区0，底部安全区0/34时：

| 区域 | x | y | 宽 | 高 |
|---|---:|---:|---:|---:|
| 标题 | 0 | 0 | 390 | 44 |
| 视频框 | 0 | 44 | 390 | 219.375 |
| 练习模式 | 0 | 263.375 | 390 | 44 |
| 字幕区域 | 0 | 307.375 | 390 | 424.625 / 390.625 |
| 进度行 | 0 | 732 / 698 | 390 | 24 |
| 播放控制行 | 0 | 756 / 722 | 390 | 44 |
| 学习工具行 | 0 | 800 / 766 | 390 | 44 |
| 底部安全区 | 0 | 844 / 810 | 390 | 0 / 34 |

底栏占844px视口的13.3%（不含设备安全区）；不按百分比压缩按钮。

## 3. 组件尺寸、位置与真实映射

| 组件 / 选择器 | 尺寸与定位 | 业务映射 |
|---|---|---|
| `.study-back` / `.study-theme-toggle` | 标题栏两侧，44×44点击盒，外侧8px | 保留返回处理；主题切换沿用 `studyThemeBtn` |
| `.study-title` | 中间剩余宽，14px，单行省略 | 当前视频标题 |
| `.player video` | 框内100%宽高、contain | 原有播放授权与媒体加载链路 |
| `[data-mobile-practice]` | 模式行左右8px、间隙4px，每格 `(W-28)/4`×44；字12px | `setPracticeMode(watch/intensive/loop/cloze)` |
| `.line-en` | 默认17px，行高1.6；仍服从字号设置 | 原字幕、逐词时间轴、词卡 |
| `.line-zh` | 13px，行高1.55，上间距5px | 对应句中文 |
| `.timeline` | 高24；时间距两侧8px，轨道区左右48px | 保留原有拖动、取消及 seek 处理 |
| `#speedSelect` | 第1列，W/6×44 | 更新 `State.speed` 与 `video.playbackRate` |
| `#dockBlind` | 第2列，W/6×44 | 隐藏字幕；再次点击恢复此前可见语言模式 |
| `#prevBtn` / `#nextBtn` | 第3/5列，W/6×44 | `selectSentence(-1/1)`，上一句/下一句 |
| `#playBtn` | 第4列，W/6×44；圆钮32×32 | 原播放/暂停处理；根据媒体事件同步 SVG 和 aria-label |
| `#openLessonMore` | 第6列，W/6×44 | 打开更多并锁定当前句供复制/收藏 |
| `#openTeachingWords` | 工具第1列，W/4×44 | 当前视频已发布重点词，去重计数 |
| `#openSavedWords` | 工具第2列，W/4×44 | 当前账号生词本；未完成加载显示“—” |
| `#markLessonLearned` | 工具第3列，W/4×44 | 云端保存学习标记，见下一节 |
| `#openQueueDirectory` | 工具第4列，W/4×44 | 视频目录、上一条/下一条视频；不与句子切换混用 |
| `#lessonMore` | 宽min(380,视口−16)，距实际底栏8；内容可滚动 | 视频切换、界面语言、设置、复制/收藏此句、字幕语言 |

所有新增 `.player-icon` SVG 为18×18、viewBox 24×24、描边1.7、`flex:none`；播放圆钮32×32，不使用非等比 transform/zoom。已修复旧 `.jump svg` 规则造成上/下句图标17×18的问题。

与独立原型的明确差异：控制行与工具行不保留8px横向内距，列宽为W/6和W/4；工具图标统一18px；模式间隔4px；英文默认17px而不在320px强制改16px。句子下方不加时间/操作描述，复制与收藏收进更多。

横屏且高度不超过500、宽度不超过850时：标题通栏，视频在左42%、模式和字幕在右58%；底栏两行44/44加安全区，隐藏进度行，避免挤掉字幕。不是强行沿用竖屏布局。

## 4. 学习标记与账号数据

“标记已学”是用户手动标记，不增加观看时长，不伪造完整播放记录。

```js
// assets/js/app.js: syncMobilePlayer 的适配器
const patch = { reviewedVideos: { [videoId]: marked ? new Date().toISOString() : null } };
const result = await EastudyData.saveLearningPreferences(patch, currentUserId);
// 只有保存成功且仍是同一账号，才更新本地状态；null 删除该视频的标记。
```

复用 `user_learning_preferences.settings.reviewedVideos[videoId]`，不新增表。保存函数检查有效学员身份与预期账号；未登录或中途换账号返回错误。按钮请求中禁用，失败保留上次已确认状态并提示重试；云端偏好加载事件同步按钮。真实观看数据仍由原媒体事件采样处理。

偏好接口使用 `patch_learning_preferences_v1`：数据库锁定当前账号偏好行后按字段合并，reviewedVideos 按视频合并，避免其他设备的未修改字段覆盖新值。同一字段同时修改仍以数据库最后接受的值为准。普通设置的待同步变更按账号保存在本机队列，联网和重新加载后重试；“标记已学”只在云端成功后显示成功，不伪造观看时长。事务验证脚本检查权限、字段保留和标记删除，最后整体回滚测试数据；它不是多设备真实并发压力测试。

## 5. 文件边界与恢复

| 文件 | 本次职责 |
|---|---|
| `shared/mobile-player.js` | SVG、移动控件组合、模式/盲听/更多、学习标记按钮、焦点恢复 |
| `assets/css/app.css` | 播放器主题、尺寸、响应式布局、组件防变形 |
| `assets/js/app.js` | 现有业务适配、媒体图标同步、视频框几何、标记持久化及加载刷新 |
| `shared/supabase-client.js` | 偏好写入的身份与预期账号保护 |
| `audit/player_loop_ui_test.mjs` | 应用布局、交互与模拟保存回归 |
| `audit/personal_library_test.mjs` | 偏好写入账号边界测试 |

审计基线为 559f267（beta6.41.0）；发布提交和验证证据见发布记录。恢复前端可重新部署该基线；本轮新增数据库函数与旧前端兼容，可保留。若需撤回新版函数，应先恢复前端再另行执行审查后的撤回迁移。不得整体重置工作区或删除 R2 对象。

## 6. 验证记录与范围

应用 Chrome/Playwright 检查10个视口：320×568、320×640、360×800、390×844、430×932、768×1024、1024×768、1280×800、1440×900、844×390。

已验证：无横向溢出、字幕跟随与手动浏览返回、底栏/图标/圆钮精确尺寸、底部安全区34px、更多弹层宽度与焦点返回、深浅主题重点词颜色稳定、盲听切换、字体设置、模式切换、词卡、自动连播与上一条、学习标记保存/取消/失败保留/加载刷新。媒体、会员和云端写入使用测试替身，不是线上实测。

通过的检查包括：

```text
node audit/player_loop_ui_test.mjs
node audit/personal_library_test.mjs
node audit/student_player_interaction_test.mjs
node audit/player_loop_contract_test.mjs
npm run test:m04
node --check assets/js/app.js
node --check shared/mobile-player.js
node --check shared/supabase-client.js
git diff --check
```

六张实际应用 DOM 截图存于 `tmp/player-blue-{light|dark}-{normal|blind|more}.png`。截图使用模拟教学数据和模拟“就绪/暂停”媒体事件，因此视频区为空；不能作为视频加载速度、真实画质、解码、发音或生产账号验证证据。不是新生成的设计图。

尚未验证真实 iOS/Android/微信浏览器、地址栏伸缩、真实安全区、实际媒体播放/TTS与云端写入。这些需要真实设备与相应服务环境验收，不能由桌面模拟视口推导“所有设备无bug”。

主页保留现有紧凑信息结构，本轮统一其雾蓝主题色；不宣称重做全部主页布局。新增同源 Supabase/HLS 静态资源、目录版本缓存和授权后的媒体边缘缓存，以减少重复下载及第三方资源依赖。缓存命中仍须通过实时会员检查，不承诺所有地区或设备的网络速度。
