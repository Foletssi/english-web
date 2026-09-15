# 手机播放器：五版双主题设计与加载、发音修正方案

日期：2026-09-15。审查对象：当前 beta6.41.0 项目；本文件为下一轮设计方案，不代表已经修改生产播放器。

归档说明（2026-09-16）：以下图片和原型为本地设计素材，不随生产提交发布；最终采用第4/5版布局及第3套雾蓝配色，实际组件、测试与发布范围见 [接入记录](design/player-blue-spec-20260916/IMPLEMENTATION.md)。下方原型链接需在保留设计素材的本地工作区查看。

## 1. 这次要解决什么

手机端每次重新打开或刷新都慢；词卡发音可能没有声音；播放器工具过大、层级过深。下一轮把主要空间留给视频和字幕，练习模式直接展开，字幕设置进入“更多”，移除手机音量滑杆和“当前句解析”面板。

重点词释义、短语解释、逐词高亮、短语整体下划线、学习计数、视频目录、上一条/下一条视频继续保留。去掉的是当前句解析入口及其占位，不是删除数据库里的教学内容。

这次产出五种布局，每种都有浅色和深色，共十个主界面；额外一张双主题“更多”面板图。它们使用同一组示例内容便于比较。示例计数和播放时间不是账号真实数据。

- [可点击原型](design/mobile-player-20260915/index.html)
- [A 熟悉而紧凑](design/mobile-player-20260915/a-light-dark.png)
- [B 留白阅读](design/mobile-player-20260915/b-light-dark.png)
- [C 拇指工作区](design/mobile-player-20260915/c-light-dark.png)
- [D 视频与歌词](design/mobile-player-20260915/d-light-dark.png)
- [E 先听再看](design/mobile-player-20260915/e-light-dark.png)
- [更多与字幕设置](design/mobile-player-20260915/f-more-light-dark.png)

## 2. 加载慢：查到了什么，还不能断言什么

| 检查位置 | 已确认的代码行为 | 影响与边界 |
| --- | --- | --- |
| `index.html:347,361` | 使用外部 jsDelivr 加载 Supabase SDK 和 HLS；Supabase 依赖写为浮动的 `@2`，都是经典脚本 | 外部请求慢可能拖延应用启动。应固定具体版本并同源交付，不能把失败全部归咎于手机网速 |
| `_headers`、线上静态响应 | HTML 禁止存储；抽样主脚本响应为 `public,max-age=0,must-revalidate` | 脚本可能复用本地内容，但刷新需要网络确认；不等于每次都完整下载 |
| `assets/js/app.js:886`、`shared/cloud-content.js:30` | `hydrateCloudContent()` 调用 `get_published_content` 取完整发布快照；没有传入已知 revision 作条件获取 | 登录完成和列表重试路径可触发整包同步；需要拆目录与当前视频教学数据。不能据此断言每次 UI 渲染都请求快照 |
| `shared/cloud-content.js:237` 附近 | 媒体会话及去重请求缓存在内存 | 刷新后内存消失，需要重新建立媒体会话；现有请求去重应复用而非重复造一套 |
| `functions/api/processing/media/[[path]].js:36,48` | HLS 请求先调用 Supabase 的 `service_resolve_playback_access_v2`，然后再读边缘缓存 | 分片命中边缘缓存仍要承受权限 RPC 延迟；这是一条值得实测的串行路径 |
| 同文件 `:57–84` | 无 Range 的播放 GET 使用边缘缓存；返回浏览器为 `private,no-store`；Range 另走 R2 查询 | 有边缘缓存，但浏览器不能持久复用这些响应。Range 不能直接套全文件缓存响应，否则会破坏 206/416 语义 |
| `functions/_lib/supabase-admin.js` | 权限 RPC 依赖远端服务，本处未见请求超时边界 | 网络慢时可能长时间等待，应增加可辨别的超时反馈及日志 |

本次桌面代理网络对首页的一个样本：HTTP 200，首字节约 1.38 秒、总计约 1.44 秒。静态脚本样本的 Cloudflare 节点后缀为 NRT。它们不能代替用户手机的 Wi-Fi/移动网络实测，也不能证明网站只有日本一个节点。

当前的优先级是修启动链路和请求时序，不是继续把 540P 降成更低分辨率。图片、HTML、脚本同样慢时，降低视频码率解决不了这些请求的问题。

### 2.1 实施顺序

1. 加入分阶段计时：页面启动、目录完成、播放授权完成、清单完成、首帧、卡顿次数/总时长。服务器分别记录权限、边缘缓存、R2 耗时，不记录令牌。
2. 固定依赖版本并同源托管，保留许可证。核心脚本按依赖顺序 `defer`；HLS 在播放路由按需加载，支持原生 HLS 时先验证原生路径。依赖变化独立评审。
3. 使用版本目录，例如 `/assets/releases/beta6.42.0/app.js`。该目录不可覆盖，允许长期缓存；HTML 使用重新验证。不要对同名文件仅换查询参数后直接承诺一年 immutable。
4. 目录按 revision 更新，视频教学内容按 videoId + publishedRevision 获取；缓存按账号隔离。可先展示已有标题和封面、同时同步。缓存不是 VIP 授权依据。
5. 给外部 RPC 增加超时和明确错误状态；只对幂等读取有限重试，避免所有分片同时重试造成拥塞。
6. 先测权限调用占比，再决定如何提速。保留当前到期/撤销即时校验要求。不能直接删掉权限 RPC、把会员媒体改成公开 URL，或仅用长时效票据掩盖延迟。若增加授权缓存，必须实现失效传播并验证撤销语义；否则保留实时校验。

计时示例，需接入现有请求函数而非另建平行数据通路：

```js
async function measurePhase(name, operation, report) {
  const started = performance.now();
  try { return await operation(); }
  finally { report({ phase: name, durationMs: performance.now() - started }); }
}

// report 仅采样时间、结果码、播放版本；不要传 access_token、Cookie。
const lesson = await measurePhase('lesson-data', loadCurrentLesson, reportMetric);
await measurePhase('media-session', ensureExistingMediaSession, reportMetric);
// 首帧优先用 requestVideoFrameCallback；不支持时用 playing + readyState 回退。
```

服务端应在已完成授权的响应上增加 `Server-Timing: auth;dur=..., edge;dur=..., storage;dur=...`。使用内置超时信号或 AbortController 约束 fetch，并把网络超时与 VIP 无效区分开。HTTP 401/403 不应按网络错误无限重试。

目标不是声称必达某个秒数：先在同一设备和网络分别采集至少 20 次冷启动/热启动，比较 p50/p95；建议首轮以首帧 p95 降低 30% 为优化目标，未达标继续定位最长阶段。记录视频时长、码率、缓存状态，避免拿不同片段比较。

## 3. 发音：为什么点击可能没有声音

`assets/js/app.js:696` 的 `speechWord()` 仅使用 `window.speechSynthesis`：同步获取声音列表、立即 cancel/speak。没有等待 `voiceschanged`，没有“请求后始终未开始”的超时检测，也没有网络音频回退。

词卡的扬声器按钮在 `:816` 调用它；点击词本身主要是打开词卡，并不是所有入口都自动朗读。生词本也调用同一个函数，但函数主要向 `#pronunciationStatus` 写错误，其他页面未必有这个元素，失败时容易呈现为完全没反应。

这证明存在兼容和反馈缺口，但尚未拿到这部手机的浏览器版本、声音列表及播放错误，不能说已确定是某一种系统故障。

### 3.1 建议采用的发音行为

点击词打开词卡，卡片明确提供“原声”按钮，播放该词或短语在视频中的片段；不要自动抢占整段视频播放。它复用已授权媒体及词级时间轴，不要求学员安装或下载声音包，也不新增一份整片音频存储。

“原声”与“英音/美音”不是同一件事，不能把原片口音标成任意选择的口音。确有英音/美音要求时，使用已授权 TTS 服务和服务端缓存，或明确标为“设备朗读”。DeepSeek 文本 API 本身不提供这些语音文件。

原声片段应交给现有播放器状态控制器处理，避免另建 audio 元素重复拉流。下面是应实现的接口和约束，不是可直接粘贴后上线的完整播放器：

```ts
type ClipRequest = {
  videoId: string;
  mediaGeneration: number;
  start: number;
  end: number;
};
interface ClipController {
  // 校验 ID、版本、有限时间戳和 start < end，边界不得超过媒体时长。
  // 从用户点击事件触发。保存原时间/播放状态/练习模式，再临时暂停练习循环。
  play(request: ClipRequest): Promise<void>;
  // 关闭词卡、切视频、切账号、用户另一次 seek 都要取消旧片段。
  cancel(reason: 'close' | 'navigate' | 'seek' | 'account-change'): void;
}
```

实现时用现有 `mediaGeneration` 或等效 token 防止异步回调污染新视频。播放到 end 时暂停；用视频帧回调与 `timeupdate` 校验边界，误差要在真机测试。缓冲期间不应简单按墙钟定时结束。自然结束才恢复原位置/原状态；若用户已主动切视频或 seek，则放弃旧状态恢复。拒绝自动播放、授权失效和片段无时间轴时均给出明确提示，不默默失败。

设备朗读的回退至少要有以下状态：

```ts
type PronunciationState = 'idle' | 'preparing' | 'playing' | 'failed';
// getVoices 非空：选实际存在的英语声音。
// 为空：监听 voiceschanged，最长等待 1200ms，然后显示可重试状态。
// speak 后 3000ms 未触发 onstart：cancel，并提示“发音未能开始，点此重试”。
// onerror：展示在当前词卡/生词本入口，不依赖某个页面唯一的 DOM id。
// 页面退出或新请求进入：解绑旧事件、清除 watchdog，递增 generation。
```

异步等待可能丢失移动浏览器要求的用户手势，因此声音初始化尽量提前，失败后让用户再次点“播放”，不要靠静音自动播放绕过系统限制。

## 4. 五版布局及各自取舍

| 方案 | 主要布局变化 | 适合谁 | 代价 |
| --- | --- | --- | --- |
| A 熟悉而紧凑（推荐） | 视频下方展开练习模式，中间滚动字幕，底部固定两行工具 | 大多数边看边学的人 | 底部工具仍较多，必须控制字长和间距 |
| B 留白阅读 | 平铺字幕、淡化非当前句、取消厚重卡片 | 精读、长时间看文字 | 同屏上下文少一些，不宜把默认字号继续放大 |
| C 拇指工作区 | 四个练习模式也移到固定底栏 | 单手手机操作 | 底栏变高，短屏需压缩视频高度 |
| D 视频与歌词 | 画面贴边16:9，17px英文、13px中文，细线分句 | 看 vlog、跟随字幕 | 字体较小，必须保留字号设置和系统字体放大支持 |
| E 先听再看 | 演示进入盲听后的隐藏字幕状态，底部轻浮层 | 听力训练 | 隐藏字幕会减少上下文提示，必须保留一键显示 |

推荐采用 A 的功能分布，加 D 的字幕密度。E 的盲听能力应能在任一布局启用，不应限定为某个主题或独立付费模式。

这些图参考用户提供截图的空间分配和固定栏模式。本轮没有重新读取竞品登录后的实时 DOM，不能把设计参数说成对方网页的真实像素或把原型代码说成复制的竞品源码。

## 5. 按键、主题与手机布局规范

主图画布为 390×780 CSS 像素的手机示意，不包含真实浏览器地址栏。图标19px、播放圆34px，主要控制点击区至少44px高。图标可以小，点击区不应无限缩小。最终返回、全屏、关闭、收藏等次级入口也应以透明内边距补足触区，不能依靠放大图标占满屏幕。

| 元素 | 浅色 | 深色 |
| --- | --- | --- |
| 页面 | `#FFFFFF` | `#101B20` |
| 面板 | `#F6F8F6` | `#18282E` |
| 正文 | `#172D2A` | `#E7F0ED` |
| 辅助字 | `#78877F` | `#90A6A8` |
| 主按钮 | `#087C69` | `#5ED8BF` |
| 重点表达 | `#976222` | `#E5BC7E` |

这是候选配色；正式实现应验证小字对比度，不能仅凭截图宣称 WCAG 全部通过。浅色辅助字若不足4.5:1，应加深。主题只更换 token，不改变按键位置和学习状态。

生产结构建议（示意，合并到现有 M04 容器，不复制整套应用）：

```html
<main class="mobile-player">
  <header class="player-header"><!-- 返回、标题 --></header>
  <section class="media-stage"><video playsinline></video></section>
  <nav class="practice-modes" aria-label="练习模式"><!-- 四个常驻按钮 --></nav>
  <section class="transcript-scroll" aria-label="字幕"><!-- 当前句及上下文 --></section>
  <footer class="player-dock"><!-- 播放、盲听、跳句、倍速、词汇、更多 --></footer>
</main>
```

```css
.mobile-player {
  height: 100dvh;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  overflow: hidden;
}
.media-stage { aspect-ratio: 16 / 9; min-width: 0; }
.media-stage video { width: 100%; height: 100%; object-fit: contain; }
.transcript-scroll {
  min-height: 0; min-width: 0; overflow-y: auto;
  overscroll-behavior: contain; scroll-padding-block: 24px;
}
.player-dock { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
.en { font-size: 18px; line-height: 1.6; overflow-wrap: anywhere; }
.zh { font-size: 14px; line-height: 1.65; }
.expression { display: inline; text-decoration: underline;
  text-decoration-thickness: 1px; text-underline-offset: .25em; }
.active-word { background: var(--word-active-bg); color: inherit; }
.control { min-height: 44px; min-width: 44px; }
.control svg { width: 19px; height: 19px; }
@media (max-height: 640px) and (orientation: landscape) {
  /* 正式实现独立横屏两列布局，不强塞纵屏五行。 */
}
```

底栏属于视口网格固定的最后一行；只有字幕容器滚动，避免 fixed 浮层覆盖字幕。旧页面的额外顶部/底部占位必须清除，否则100dvh之外再叠一层导航仍会溢出。微信内置浏览器、Safari 地址栏收缩和键盘弹起须真机确认。演示视频画面来自用户截图裁切，生产必须使用完整原视频，不照抄裁切比例。

短语下划线通过 inline 文本装饰逐行绘制；逐词跟随只高亮单个 token，不再在跨行短语外层使用绝对定位边框。点击短语内任意词仍打开同一短语卡。

## 6. 必须明确的交互状态

```ts
type PracticeMode = 'watch' | 'intensive' | 'loop' | 'cloze';
type CaptionMode = 'bilingual' | 'english' | 'chinese' | 'hidden';
type PlayerPreferences = {
  practice: PracticeMode;
  captions: CaptionMode;
  blind: boolean;
  rate: number;
  autoNextVideo: boolean;
  theme: 'light' | 'dark';
};
```

练习、字幕语言和盲听是独立状态。盲听只暂时隐藏当前字幕显示，不覆盖用户保存的字幕语言。退出盲听恢复原偏好，不改变句子和播放位置。原视频烧录字幕无法通过隐藏网页字幕去掉；若要隐藏整个画面，必须另设明确的“仅听声音”，不可默默黑屏。

连续播放：到句末继续；逐句暂停：到句末暂停，再按播放从本句开头重听，点击下句才前进；单句循环：到句末回到本句起点；听写填空：隐藏教学重点表达，复用现有填空判定，不在此轮增加录音识别。开启盲听时，不应同时把答案词卡自动弹出来。

“上句/下句”和“上一条视频/下一条视频”分别控制句子和视频，不能复用同一个索引。最后一条视频结束后不越界；单句循环状态不触发跨视频自动播放。视频切换要取消旧发音、旧字幕滚动、旧授权回调。

更多面板只呈现字幕语言、字号、主题、自动连播和目录相关入口。完整宽度的底部面板加有限高度及内部滚动，正式实现用 `dialog` 或具备焦点约束、背景 inert、Escape 关闭、关闭后恢复焦点的组件。

生词本计数来自当前登录用户去重词条；重点词来自当前已发布视频的有效表达集合，不能把草稿候选条数当学员计数。原型的28/3只是排版数据，实施时替换为已有学习数据接口。

进度条采用横向拖动意图识别：纵向滚动不 seek；按下后横移超过阈值才预览时间，抬手提交；提供取消处理。进度细线视觉高度3px，触区单独留足，不把细线本身当唯一触区。手机音量用系统物理键，页面不再提供大滑杆。

## 7. 模块边界与验收

M04：布局、模式状态、字幕、词卡发音、媒体计时。静态交付层：资源路径和缓存。内容读取层：目录/教学数据加载。M01 权限：只在有测量证据时单独评审性能调整，禁止借提速改成未授权可看。M08 DeepSeek 内容生产不因界面换版重新生成或覆盖已发布教学内容。

实施分三个可独立回退批次：①静态加载和计时；②选定的播放器布局及发音反馈；③根据真机时序优化媒体/数据请求。每批只提交相关模块。

验收须包括：有效VIP、过期VIP、撤销VIP、退出/换账号；首页刷新和视频深链接；微信内置浏览器、Android Chrome、iOS Safari；320/360/390/430宽度、短屏横屏、系统大字体；英语长词与跨行短语；盲听进出、逐句暂停重听、单句循环、上一视频返回、字幕语言恢复；发音未开始/拒绝播放/网络失败/切视频竞态；更多面板滚动和焦点；计数和实际账号一致。

本次已验证的是本地原型：10个主界面、4种预览视口宽度，无横向溢出、字幕容器有空间、底栏不覆盖容器；模式选择、盲听切换、字幕隐藏、目录上条入口、Escape 关闭已检查，无 pageerror。结果在 [verification.json](design/mobile-player-20260915/verification.json)。这不等于真实手机音频、VIP权限和生产网络已验收。

## 8. 图像来源、提示词与交付方式

按 PrismForge 做五版系列的统一信息层级、参考图职责和深浅主题约束，并按 imagegen 核对实际生成入口。本次工具清单没有内置 image_gen；也没有实际调用名为 image2.5 的模型。交付图片是 HTML/CSS 在本地 Chrome 渲染的设计图，可与原型代码一一对应，不冒充模型生成结果。若后续明确采用 API/CLI 生图，需使用可用模型及已配置的接口；本次未调用收费生图API。

参考图1 `4ddb...jpg`：固定操作栏、练习与字幕位置参考。参考图2 `8ea...jpg`：现有功能和拥挤问题参考，其中的视频截图裁切用于各版一致的画面占位。不从截图推断对方后台、版权授权或实时按钮实现。

以下编译提示词可用于后续真实生图；当前已用于约束代码原型设计：

```text
Use case: ui-mockup
Asset type: 中国成人英语 vlog 学习网站的手机播放器界面
Composition: 同一版本的两台手机并排，左浅色、右深色，逐项功能位置一致。
Reference image 1: 仅参考紧凑、固定底栏、练习入口直接展开的层级。
Reference image 2: 参考现有功能，移除其中拥挤的大解析面板和手机音量控件。
Keep: 视频、当前句、上下文、短语整体下划线、单词逐个高亮、重点词计数、生词本计数。
Exact labels: 连续播放 / 逐句暂停 / 单句循环 / 听写填空 / 倍速 / 盲听 /
上句 / 下句 / 更多 / 重点词 / 生词本 / 标记已学 / 视频目录。
More only: 字幕设置（双语、英文、中文、隐藏）、字号、主题、自动连播。
Avoid: 当前句解析、手机音量滑杆、跨行短语包围边框、巨型按钮、无意义的字幕省略点。
Typography: 英文17–19px视觉比例、中文13–14px；细线、克制留白、真实小屏布局。
Theme: 白底墨绿文字，与深蓝灰底浅文字；重点表达金棕色，主操作青绿色。
```

五版各自追加：A“顶部四练习、底部两排工具，字幕占中部”；B“扁平精读、淡化非当前句、取消卡片”；C“练习模式移到底部并保持展开，强调拇指操作”；D“视频贴边16:9、17px歌词式字幕、减少行间额外控件空间”；E“盲听初始状态、隐藏文字但保留一键显示，底栏轻浮层”。每版独立输出，不把五版混成一张无法阅读的九宫格。

原型文件：`design/mobile-player-20260915/index.html`、`design.css`、`design.js`。渲染脚本 `render.cjs` 使用现有 Playwright 和系统 Chrome，无新增依赖。所有改动仅在 docs 中，未部署。
