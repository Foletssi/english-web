# 手机学习播放器与重点词迭代执行方案

日期：2026-09-15。状态：beta6.41.0 已完成本地实现与回归；生产执行状态见文末发布记录。

本轮读取的本地版本：`40fcb75`，最近应用版本为 beta6.39.0。修改前必须重新核对 main、线上版本与工作区；不能把本次读取的版本永久当作生产版本。

本方案更新旧《竞品对比与分模块优化方案》中“无法访问已登录页面”等过时结论。视频继续采用既定单档540P，本次不调整媒体规格、登录或会员权限。

## 1. 用户要求与最终行为

1. 面向有英语基础的成人。重点词优先选择具有教学价值的四级及以上词汇、自然搭配、短语动词和习语；不把 `we love you`、`I just know`、`my makeup` 等普通片段凑成重点短语。
2. 每句可以没有重点词。不能为了填满界面或计数而自动补词；已有人工锁定的选词不能被重新分析静默覆盖。
3. 字幕播放进度逐个单词推进。短语的语义下划线覆盖整个短语，包括中间空格；跨行自然分段，没有跨两行的大包围框、竖边或高度撑开。
4. 将按钮 `1 / 2 · 目录` 改为“视频目录”。目录内仍可显示总数和当前视频位置。
5. 手机下方始终有操作区。缩小按钮视觉尺寸，但保留足够触摸范围；常用功能可以直接访问，更多功能面板不裁切。
6. 删除中文字幕下的 `•••` 操作入口。保留复制、收藏能力，移动到明确标注的句子操作面板。
7. 重点词和生词本显示真实数量；它们是不同数据，不能混用。保留双语、英文、中文、跟读、挖空、听写等已有学习功能。
8. 视频连续播放时能够返回上一视频。上一句/下一句与上一视频/下一视频必须有不同文字、图标语义和处理函数。
9. 字幕字号适度、区域能独立滚动；视频不挤压字幕，字幕区域不再增加描述性文案。

## 2. 这次实际读取和操作了什么

来源：

- 合集：<https://vel.yueshu365.com/library/266>
- 最初视频：<https://vel.yueshu365.com/library/266/episode/9335?content_type=video&opened_from=library_detail>
- 后续受控操作视频：<https://vel.yueshu365.com/library/266/episode/9337?content_type=video&opened_from=library_detail>
- 已发布前端脚本：<https://static.yueshu365.cn/releases/user-app-domestic-production-20260908_001122/assets/index--8E_WXyA.js>

已经访问用户登录的 Chrome 页面，读取渲染后的 DOM、计算样式和公开前端资源；实际点击更多、视频目录、重点词、上一句、下一句，并测试字幕滚动和三个手机视口。

官方 Codex 浏览器连接器的 `unsupported Codex auth method: apikey` 未被修复。这次研究通过用户已开启的 Chrome 调试连接完成，不能把它描述为官方连接器恢复。该研究连接不用于生产部署。结束时已恢复1920×855桌面视口、关闭打开的词汇面板并断开调试连接，保留用户浏览器和标签页。

能看到的是交付浏览器的前端代码及实际交互，不能据此声称拿到了竞品后台源码、AI提示词或数据库实现。手机数据来自浏览器视口模拟，不等同于已完成微信、Safari等真机验收。

### 2.1 布局测量

单位为CSS像素，顶部原点是网页视口。测量时未打开更多或目录面板。

| 视口 | 视频高度 | 字幕滚动区域：顶部 / 高度 | 控制区：顶部 / 高度 | 底部菜单：顶部 / 高度 | 页面宽度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 360×667 | 202.5 | 242.5 / 316.5 | 560 / 69 | 629 / 38 | 360 |
| 390×844 | 219.375 | 259.375 / 476.625 | 737 / 69 | 806 / 38 | 390 |
| 430×932 | 241.875 | 281.875 / 542.125 | 825 / 69 | 894 / 38 | 430 |

三个视口没有页面横向溢出。视频呈16:9。字幕滚动350px后，视频、控制区和底部菜单位置不变。

关键不是把所有按钮设为 `position:fixed`：竞品实测控制区是 `position:relative`，通过定高页面、网格分配和字幕独立滚动，让操作区视觉上固定在底端。

在390px视口：

- 字幕上方标签高38px，字号13px；双语、跟读、挖空、听写词在一行。
- 控制区普通按钮视觉28×28px，播放按钮34×34px，下方小字约8.5px。
- 更多面板宽344px、高192px、四列，位于底栏上方。包括音标、循环、连播、标题、字幕、屏词、全屏、字号、主题、高亮、偏移、PDF、小窗等。
- 目录面板约86vh，真实列出226期内容；重点词面板约84vh。
- 初始视频英文字幕计算字号约17.14px、行高26.74px。可能受用户已保存设置影响，不能称为竞品默认值。

按钮做小有助于紧凑，但其小字和28px点击区域不值得完全照搬。我方建议图标视觉20—24px、按钮触摸区域至少44×44px。

### 2.2 按钮行为验证

在9337页面进行受控上下句测试：

| 操作 | 视频时间 | 当前句 | 字幕滚动位置 | 路由 |
| --- | ---: | ---: | ---: | --- |
| 操作前 | 29.38秒 | 9 | 1269 | 9337 |
| 下一句 | 32.81秒 | 10 | 1428 | 9337 |
| 上一句 | 29.00秒 | 9 | 1269 | 9337 |

按钮同时调整视频位置和字幕位置。测试后已暂停播放。早期曾出现页面切换，原因未确定，不纳入“上一句/下一句导致切视频”的结论。

打开更多、目录、重点词面板均已确认。没有测试收藏写入、购买、麦克风或已学标记；普通播放可能按网站自身逻辑保存观看进度。

9335显示55个重点词、39段字幕、时长2分21秒；9337显示61条重点词。例词包括 `ongoing`、`self-discovery`、`resonate`、`transformations`、`immersed`、`swamped`，也发现 `doing` 这样的基础词，因此竞品选词并非全部合理。用户截图中的约449项与竞品不是同一视频样本，不能直接用数量推导优劣。

### 2.3 可参考的前端结构

下列是公开样式中与问题直接相关的小片段，省略构建生成的作用域属性和外观属性：

```css
.learn-content-grid.is-mobile {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  height: 100%;
}
.learn-subtitle-list {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
}
.learn-control-dock__more-panel {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  width: min(344px, calc(100vw - 12px));
  padding: 8px;
}
```

复用的是区域划分、滚动边界、按钮分组和弹层定位思路。实现代码应适配我方状态及数据接口，不整包搬运竞品脚本、账户信息或品牌素材。

## 3. 我方已定位的问题及边界

以下路径均相对仓库根目录 `E:/英语网页制作/Eastudy_Composite_V1_Beta6_17_VocabularyLogic`。行号是本次读取位置，实施时按函数定位。

| 板块 / 文件 | 已读到的逻辑 | 问题与处理 |
| --- | --- | --- |
| M08 `services/local-studio/ai_tools.py:181` | 提示词已允许每句0—3项、长句最多5项，也禁止普通修饰语凑短语 | 不能归因于“没写提示词”。需增加成人教学筛选标准，并修复下游补词；上限不是必须选满 |
| M07/M08契约 `shared/content-store.js:88` | `keyWords`为空数组时回退种子数据 | 人工或AI明确清空可能失效；区分空值与字段缺失 |
| M04 `assets/js/app.js:473` | `sentenceKeywords`没有手动词时，从词典推选一个词 | 抵消“不选重点词”的结果；删除正式内容的猜测式补词 |
| M04 `assets/js/app.js:430` | 短语候选合并本句词和全局词典短语 | 当前句未被选定的词典短语仍进入短语处理；词典释义与教学重点必须分开 |
| M04 `assets/js/app.js:312` | 重点词计数基于 `keyWords`，过滤条件与已审核词卡不完全相同 | 高亮、词卡、重点词列表和计数统一消费同一份表达集合 |
| M04 `assets/js/app.js:460`、`assets/css/app.css:1290` | 已拆成逐词span，但短语空格在span外，各单词独立下划线 | 不是完全没做逐词；尚缺语义短语容器。使用外层行内短语、内层逐词时间 |
| M04 `assets/js/app.js:297` | 目录按钮拼接序号/总数 | 按钮改为“视频目录”，序号进入目录面板 |
| M04 `assets/js/app.js:520` | 每句输出 `summary` 文本 `•••` | 删除逐句省略号入口，集中提供复制当前句/收藏当前句 |
| M04 `assets/css/app.css:1423` | 更多面板绝对定位，`max-height:70%`；父级工具条约44px高且有定位 | 存在按狭小包含块计算高度的风险；独立弹层。此项已有源码依据，仍须我方浏览器复现验收 |
| M04 `assets/css/app.css:1416` | 控制按钮、跳转按钮的最小尺寸较大 | 不能只等比例缩放；改移动端专用布局，区分句子控制和视频导航 |
| M08/M07 `shared/learning-contract.js` | 校验原文边界、解释和审核状态，允许空表达列表 | 保留这些契约；不要另造一套不兼容的客户端“审核通过”定义 |

`shared/content-store.js`中“没有重点表达”的检查目前是警告。不能未经调用链核实，把它说成所有视频发布失败的直接原因。实施时将明确完成选词且结果为空视为正常，只有分析未完成才保留相应告警。

本次不是全站无遗漏审计。只对上述相关入口形成了证据；真实手机适配、我方弹层运行结果和生产链路仍须在实施阶段验收。

## 4. AI重点词与数据契约修正

### 4.1 生成规则

目标人群是具备基础的中国成人。考试名称可作为学习目标，但不能将CEFR与四级、六级、雅思、托福机械等同，更不能凭模型判断给每个词伪造“官方四级词汇”标签。

对 `LEARNING_PROMPT` 增补以下约束，保留已有JSON契约：

```text
你的学习者已掌握基础英语，学习目标包括四级、六级、雅思、托福和自然口语。
选择顺序：有语境学习价值的进阶词汇 → 短语动词/习语 → 有迁移价值的固定搭配。
不要选择普通主谓宾片段、功能词、代词加常见动词，或仅加my/the/a的名词词块。
例如 we love you / I just know 通常不选；my makeup 不因my而成为固定短语。
基础词仅在本句体现非基础的习语义、多义用法或固定结构时才可入选。
单词是否简单不能只按字符数判断；词组是否有价值不能只按词数判断。
每句可以返回 keyWords: []、expressions: []；不能为了数量凑词。
selectionReasonZh 必须指出本句值得学的具体义项、结构或用法，不写空泛的“很常用”。
无可信词表证据时不标注具体考试归属；难以判断的内容 needsReview=true。
```

不增加“每分钟必须有多少词”硬指标。管理端可提示异常密度、重复率供复核，但不能用密度指标填充或截断教学内容。

`LEARNING_REPAIR_PROMPT`用于补解释时会保留指定选词；重新筛选必须走已有 `LEARNING_REEXTRACT_PROMPT` 路径。不能误用“只补释义”任务来期待删掉不合适的词。

### 4.2 明确空数组并取消前端补词

下例为拟实施代码，需结合现有规范化入口接入，不是当前代码已修改：

```js
// 正式内容：[] 表示选词已完成且没有重点表达，必须尊重。
const keyWords = Array.isArray(row.keyWords)
  ? row.keyWords
  : []; // 历史字段缺失由迁移/修复任务处理，不猜测种子词

function sentenceKeywords(sentence) {
  return approvedTeachingExpressions(sentence).map(x => x.surface);
}

function approvedTeachingExpressions(sentence) {
  // 在 shared/learning-contract.js 的现有审核规则上提供公开只读选择器。
  // 此处示例显示核心要求，原文匹配与版本判定沿用契约实现。
  const selected = new Set((sentence.keyWords || []).map(normalizePhrase));
  return (sentence.expressions || []).filter(expression =>
    selected.has(normalizePhrase(expression.surface)) &&
    (expression.reviewStatus === 'APPROVED' || expression.approved === true) &&
    expression.needsReview === false &&
    expression.coreMeaningZh?.trim() &&
    expression.contextMeaningZh?.trim() &&
    sourceRevisionMatches(expression, sentence) &&
    sourceSurfaceMatches(expression.surface, sentence.en)
  );
}
```

`sourceRevisionMatches`和`sourceSurfaceMatches`是示例中的契约适配函数，实施时必须实现并测试，不能原样调用不存在的函数。旧记录缺版本时走既有受控兼容/修复策略，不能一律清空，也不能无条件认为最新。

新增公共选择器后，重点词高亮、重点词面板、计数、挖空目标统一调用。普通词仍可以查询词典，但不自动进入重点词或改变其计数。空重点词句子在挖空模式显示正常句子，不临时随机挖空。

### 4.3 旧视频如何处理

1. 读取已发布视频的教学版本和人工锁定项，保存现有教学快照；不复制或转码媒体。
2. 用重新选词任务生成候选集，人工锁定项保持；分析失败保留当前可用版本。
3. 校验字幕ID全量覆盖、原文连续边界、解释非空、无重复、选词和表达一一对应。
4. 管理端展示“新增/移除/保留/待复核”差异。待复核内容不能进入已审核词卡。
5. 通过审核后，服务端检查视频教学版本未变，再原子发布；发生并发编辑则返回冲突而非覆盖。
6. 已有生词本属于用户学习记录，不能因视频重新选词而删除。对原词卡保留词头和来源，必要时更新解释版本。

不从学生端直接调用DeepSeek，也不暴露API密钥。本次不重新上传540P、不删除R2对象。

## 5. 字幕：短语整体下划线，播放逐词高亮

### 5.1 结构

```html
<span class="teaching-expression" data-expression-id="exp-12">
  <span class="timed-word" data-start="12.10" data-end="12.28">put</span>
  <span class="timed-word" data-start="12.29" data-end="12.46">up</span>
  <span class="timed-word" data-start="12.47" data-end="12.71">with</span>
</span>
```

实际渲染必须保留原句空格和标点；HTML中的换行示意不能取代原文。外层表示一个教学表达，词间空格也在外层内部。内层仅负责单词时间。普通文本使用 `textContent` 或已有转义函数，不插入AI原始HTML。

```css
.teaching-expression {
  display: inline;
  color: var(--keyword-color);
  text-decoration-line: underline;
  text-decoration-thickness: .08em;
  text-underline-offset: .20em;
  text-decoration-skip-ink: auto;
  border: 0;
  background: none;
  white-space: normal;
}
.teaching-expression .timed-word { color: inherit; }
.timed-word.is-speaking {
  background: var(--word-progress-background);
  border-radius: .15em;
  /* 不覆盖重点词颜色，不设置整短语定位边框。 */
}
.subtitle-en {
  font-size: 17px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.subtitle-zh { font-size: 14px; line-height: 1.55; }
```

实现时沿用已验证的逐词时间有效性判断。估计时间、词数量不一致、字幕文本变更后旧对齐失效时，只做句子高亮，不假装有准确逐词对齐。

短语选择只来自本句有效教学表达，多个表达重叠时在契约或区间规划阶段确定唯一、不交叠的可视范围。不能靠嵌套任意span造成重复点击和样式叠加。

点击短语任一单词或空格都打开同一词卡；词卡按表达ID/词头归并。重点色与播放背景分开，播放经过后重点色和下划线不消失。

### 5.2 跟随滚动

仅滚动字幕容器，不使用会连带滚动整页的默认 `scrollIntoView()`：

```js
function followActiveSentence(list, row, smooth = true) {
  if (!list || !row) return;
  const box = list.getBoundingClientRect();
  const item = row.getBoundingClientRect();
  const top = list.scrollTop + item.top - box.top
    - Math.max(0, (list.clientHeight - item.height) / 2);
  list.scrollTo({
    top: Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight)),
    behavior: smooth ? 'smooth' : 'auto'
  });
}
```

逐词事件不反复滚动；当前句变化才跟随。用户手动浏览时临时暂停自动追赶，用一个短小“回到当前句”按钮恢复；切句、恢复跟随后重新定位。尊重系统减少动态效果设置，弹层打开时不争抢焦点。

## 6. 手机布局与操作区

### 6.1 区域分配

从上到下：紧凑返回/标题区 → 视频 → 字幕模式栏 → 可滚动字幕 → 句子控制区 → 底部功能栏。只有字幕区占据剩余空间并滚动；不要在字幕中加入说明文案。

```css
.mobile-classroom {
  height: 100vh;
  height: 100dvh;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto auto;
  min-width: 0;
  overflow: hidden;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  box-sizing: border-box;
}
.mobile-classroom > * { min-width: 0; min-height: 0; }
.video-stage { aspect-ratio: 16 / 9; background: #000; }
.video-stage video { display: block; width: 100%; height: 100%; object-fit: contain; }
.subtitle-scroll { overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain; }
.sentence-controls { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); }
.sentence-controls button { min-height: 44px; min-width: 44px; padding: 4px; }
.lesson-navigation { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.lesson-navigation button { min-height: 48px; min-width: 0; }
```

这是拟议新容器的结构示例，不可在旧 `videoPage` 固定行高规则上直接叠一层。实施时清理M04冲突规则和重复DOM迁移，桌面端保留独立布局。

常用句子控制区六项：倍速、上一句、播放/暂停、下一句、单句循环、更多。底部四项：重点词（数量）、生词本（数量）、视频目录、视频切换。视频切换面板提供“上一视频”“下一视频”和“自动连播”，与句子按钮明确区分。实际标签以360px验收为准，不能用省略号截断关键功能名。

字幕模式栏保留双语/英文/中文切换及已有练习入口；空间不足时使用两个明确的分组菜单“字幕设置”“练习模式”，不能直接删掉功能。关闭菜单后仍能看清当前模式。

低高度、横屏和软键盘打开时必须有独立策略：视频限制高度、辅助标签适度折叠，输入区可见。不能为了保留16:9而把字幕区域压到零。具体断点用测量决定，而不是宣称一套高度适合所有手机。

### 6.2 更多面板与句子操作

更多面板使用页面级 `<dialog>` 或等价顶层弹层，不放在44px工具条的百分比高度容器内：

```css
.lesson-more {
  position: fixed;
  inset: auto 8px calc(var(--lesson-dock-height) + env(safe-area-inset-bottom, 0px) + 8px);
  width: min(380px, calc(100vw - 16px));
  max-width: none;
  max-height: min(60dvh, 400px);
  margin: 0 auto;
  padding: 12px;
  overflow: auto;
  box-sizing: border-box;
}
.lesson-more-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.lesson-more button { min-height: 44px; min-width: 0; }
```

`--lesson-dock-height`由真实底部操作区测量并在布局改变时更新，不写死为竞品高度。若用 `dialog.showModal()`，必须实现关闭按钮、Escape、合理的背景点击关闭和焦点返回；小窗/全屏时验证弹层所在文档及权限限制。

更多容纳不常用的音标、字号、主题、高亮、字幕偏移、AB循环及现有其他设置；不得以重排为由删除已有功能。复制当前句、收藏当前句使用清晰按钮；面板打开时固定目标句ID，播放继续后不能悄悄变成另一句。

### 6.3 计数和视频切换

- 重点词：当前视频已审核表达按规范化词头或表达键去重后的数量；同一个词多次出现不重复计数。列表与数字必须用同一个选择器。
- 生词本：当前登录用户的生词总数，切换账号立即隔离；显示“本视频”筛选时同步改变标签和统计范围。
- 数量读取中显示轻量占位，不能先显示0再跳到真实值；失败提供局部重试，不伪装为空。
- 保存/取消保存后在成功结果上更新数字；乐观更新必须能失败回滚。
- 视频队列采用进入时的合集/筛选上下文和稳定ID，不能根据当前页面DOM重新拼顺序。
- 自动连播与上一/下一视频共用同一队列索引逻辑。首尾按钮禁用并明确状态；下一视频授权失败时保留返回和重试入口。
- 切换视频必须取消旧异步请求、解除旧播放事件；不允许旧字幕响应覆盖新视频。
- 自动播放被手机浏览器阻止时显示“点击播放”，不要将它误判为媒体故障。

## 7. 实施顺序和验收门槛

### 阶段A：教学数据契约（M08，关联M07/M04）

先统一空数组、审核状态、原文版本和计数选择器，再修改提示词。测试包括：空数组不回填、未审核不高亮、普通词查询不进入重点词、相同词头多次出现计数一致、人工锁定不丢失、重分析并发冲突不覆盖。旧数据先生成对比结果再发布。

### 阶段B：字幕渲染（M04）

完成短语外层和逐词内层结构，删除整短语边框；移除 `•••`，接入明确句子操作。验证长短语跨两行/三行、标点、重复短语、长单词、字号调整、暗色模式、错误或缺失时间戳。高亮前后颜色保持，点击短语每个位置都指向同一卡片。

### 阶段C：移动端布局（M04）

完成独立滚动和永久底栏、更多弹层、视频目录名称和前后视频切换。保留原功能及已保存设置，窗口反复变宽/变窄不能重复挂按钮或监听器。

| 验收项 | 可观察结果 |
| --- | --- |
| 320/360/390/430px宽度，短屏和横屏 | 页面无横向溢出，关键按钮不遮字，可操作 |
| iPhone安全区、Android Chrome、微信内置浏览器 | 底部不被系统条遮挡；地址栏伸缩后字幕仍可滚动 |
| 连续播放并手动滚动字幕 | 底栏位置稳定，自动跟随尊重手动阅读 |
| 更多、目录、重点词、生词本 | 面板完整可读、内部可滚动、可关闭、焦点正确 |
| 上一句/下一句和上一视频/下一视频 | 各自改变正确的状态，没有串用事件 |
| 慢网、字幕延迟、断网重连 | 显示真实加载/失败状态，没有“无字幕”闪烁误报 |
| 空重点词、词卡和收藏失败 | 不补词、不伪造释义、计数可回滚 |

触摸误拖进度条、单句循环、VIP媒体准入、540P播放等既有功能做回归验证；没有证据时不改这些模块。

自动化执行已有 `npm run test:m04`、`npm run test:m08`、`npm run test:module-boundaries`；公共契约改动还需运行所有受影响消费者测试。最后运行项目要求的全量检查。新增测试应覆盖真实失败情形，不只检查代码字符串是否存在。

### 阶段D：审查与部署

用户确认实施后，使用 code-review 对实施时确认的基线审查，逐项核对本文件要求与测试证据。不能以“构建通过”代替按钮实测，也不能声称绝对无Bug。

生产顺序遵循仓库 AGENTS.md：所需Supabase前向迁移先验证成功，再快进main、推送GitHub、等待Cloudflare Pages、核对学生端和管理端。若不需要数据库迁移，应明确记录无迁移，不能制造空迁移。

连接器若仍不支持apikey，已获授权的生产操作使用官方CLI/Git/HTTPS验证通道；本次研究的调试连接不用于部署。上线不物理删除R2对象，不处理无关工作区内容。回滚需同时考虑前端版本与教学数据版本，采用已验证可兼容的版本回退，不能直接抹去用户新增学习记录。

## 8. 交付内容及完成定义

实施后应交付：相关模块代码、必要的教学数据差异和版本记录、自动化测试结果、手机布局/按钮实测记录、代码审查问题及处理结果、部署版本和线上验证结果。

“完成”意味着：本文件九项用户要求均有实现与验收对应证据；剩余限制明确列出。beta6.41.0 已完成本地实现和回归，包括教学契约、结构化审核、逐词跟随与短语下划线、手机底栏及独立面板。生产执行状态、旧视频候选处理和真实设备验证边界统一维护在 [发布记录](../tasks/release-beta6.41.0.md)，不以本设计文档替代验收证据。
