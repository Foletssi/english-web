# 手机端图片链路、雾蓝 UI 与难度展示：审计及修复执行方案

日期：2026-09-16。状态：**审计与待执行方案，本文不代表代码已经修改或部署。**

实施进展与最终证据请看 [本轮执行记录](ITERATION_STATUS_AND_EXECUTION_20260916.md)；下文保留为当时的方案，不作为当前上线状态。

核对版本：线上与本地 HEAD 为 `faf9ef3 / beta6.42.0`；沿用已确认的审计基线 `559f267 / beta6.41.0`。差异审计使用 `git diff 559f267...HEAD`；另外检查当前图片路由、转码迁移和目录代码，历史遗留问题不一概归因于本次发布。

目标：落实用户选中的第 3 套雾蓝视觉，以第 4 版常驻播放器布局、第 5 版盲听布局为结构依据；修复封面加载通路；首页及发现页改为手机双列小图；将面向学员的难度统一为四级、六级、雅思、托福。保留必要学习功能、重点词颜色、540P 视频及会员规则。

本轮交付是可供 AI/开发人员执行的文档。以下示例是拟议实现及接口契约，标为“新增”的方法目前不存在，不能直接调用后就宣称完成。实施时需要完成调用方、服务端、数据迁移和测试的对应接入。

## 1. 用户截图与必须处理的内容

| 截图 | 实际页面/内容 | 必须处理 |
|---|---|---|
| 第 1 张 `a856e432…jpg` | 发现页“全部合集”，并非首页；合集大封面失败 | 修复合集封面引用和鉴权；发现页同步采用双列小卡，不能只改首页 |
| 第 2 张 `7420f73d…jpg` | 播放器“更多与句子操作” | 用紧凑雾蓝菜单替换粗边框大按钮；显示真实操作状态 |
| 第 3 张 `844334e…jpg` | 学习偏好弹层 | 去掉重复编号、演示内容和大段说明；保留实际设置，统一深浅主题 |
| 第 4 张 `b0c796e1…png` | 已选雾蓝播放器参考图 | 保持视频、模式、字幕、底栏的位置关系，落实图标、选中态、间距与弹层 |
| 第 5 张 `875578b3…png` | 已选雾蓝视频书架参考图 | 搜索、横向继续学习、小分类、双列视频卡；避免大图和重复推荐块挤占屏幕 |

对齐标准是参考图的设计规则与实际页面截图，不是只把主题色换成蓝色。示意图中的样例标题、数量和视频不能复制为真实数据。

## 2. 审计结论与证据边界

### 2.1 已确认：上一版没有覆盖全部设计要求

`docs/design/player-blue-spec-20260916/IMPLEMENTATION.md` 明确记载：

> 主页保留现有紧凑信息结构，本轮统一其雾蓝主题色；不宣称重做全部主页布局。

这解释了为什么已经有好看的首页设计图，网页却仍是旧卡片布局。播放器底栏已经接入部分雾蓝样式，但 `shared/mobile-player.js` 的更多菜单与 `index.html` 的偏好弹层保留旧结构，主题作用范围也没有覆盖所有弹层。不是仅靠刷新缓存就能解决。

之前的测试能证明若干尺寸、事件和布局边界通过，不能证明所有页面与设计图一致。先前记录也明确：部分 UI 验证采用模拟媒体和数据，不是手机真实网络验收。

### 2.2 已确认：手机单列源于 CSS 规则

`assets/css/app.css` 的 `#mobileVideoList` 当前规则：

```css
grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
```

390px、430px 手机扣除边距后，放不下两个最小 280px 的卡片，所以必然变成单列。另有小屏 `.browse-grid` 强制一列的规则，影响第 1 张图对应的合集页。只调整图片宽度，不修改列定义和旧规则冲突，无法完成双列布局。

### 2.3 高优先级：合集封面存在旧任务引用的具体证据

本地保存的 `tmp/content-audit-before-production.json`（文件时间 2026-09-15 19:46:25）中：

| 对象 | 当时保存的封面任务 |
|---|---|
| 合集 `1001`“真实生活日常 Vlog”，草稿和发布态 | `c295fa07-9d5f-4b3d-b1e1-1e915ac78249` |
| 已发布视频 `1788926081632` | `6720ee44-4a40-4e27-b65e-27bb4aac4a30` |
| 已发布视频 `1789024924932` | `f3514b27-14d7-4f61-a61b-308c4af2ae54` |

这些 URL 都是 `/api/processing/media/{jobId}/cover.webp`。

`supabase/migrations/20260915090000_mobile_balanced_540.sql` 中的 `service_commit_balanced_reencode` 更新了草稿和发布态的 **videos** 数组、任务 ID 与视频封面，但没有同步 **collections** 中引用旧任务的封面。

同文件中的 `service_resolve_playback_access_v2` 要求：请求任务必须是该视频**当前已发布的 processingJobId**，并且任务完成、视频未进回收站、账号有观看权限。合集沿用旧任务 URL 时，可能被正确的权限规则拒绝，即使 R2 对象仍然存在。

**结论边界：**已证实历史快照有旧引用风险、转码更新范围有缺口、权限解析有上述约束。尚未读取当前登录账号下的最新生产快照与失败请求，不能把截图这一次失败直接断言为 403，也不能断言图片已经丢失。实施第一步必须取当前记录与请求状态核实，然后定点修复。

### 2.4 已确认：封面会话失效被误报成服务异常，恢复链路不完整

文件与行为：

- `functions/api/session.js`：目录封面票据 `eastudy_catalog` 最长有效 300 秒。
- `shared/cloud-content.js / syncMediaSession`：只有 `jobId` 存在时安排续期；目录票据没有相同续期处理。目录和播放还共享每个 scope 的活动键与定时器，不能简单加一个目录定时器，否则可能干扰播放续期。
- `functions/api/processing/media/[[path]].js`：封面票据验证与权限 RPC 放在同一个 `try/catch`。无票据、过期票据和 RPC 故障都可能返回 `503 PLAYBACK_AUTH_UNAVAILABLE`。
- `assets/js/app.js`：首次目录会话同步失败被吞掉后继续渲染；合集图片没有统一的失败分类、凭证恢复与有限重试。

本次无 Cookie 的线上只读请求确实得到旧合集 URL 的 `503 PLAYBACK_AUTH_UNAVAILABLE`。这只证实匿名/无票据场景的错误分类，不证明有效 VIP 请求也返回 503。

### 2.5 已确认：图片缓存命中仍可能等待鉴权

媒体路由在读取 `caches.default` 前执行权限 RPC。浏览器收到的封面响应是 `Cache-Control: private, no-store`。因此刷新会重新请求；即使媒体对象在边缘 HIT，也仍要完成权限检查。

这不是“Cloudflare 缓存开了就一定快”。Cloudflare Cache API 的缓存也不自动跨数据中心复制。应分别测 `Server-Timing` 的 authorization/delivery、缓存命中与图片下载，不能拿一次代理测量推断所有手机网络。

### 2.6 已确认：封面可以缩小，但没有证据表明体积是首要原因

`services/local-studio/media_tools.py / make_cover` 当前生成单张 1280×720 WebP、质量 85。`services/cloud-worker/reencode-existing.py` 转 540P 时复制旧封面，不会同步缩小封面。

本地已有媒体产物测得：

| 文件 | 压缩文件大小 | 说明 |
|---|---:|---|
| `tmp/balanced-540/video1/cover.webp` | 34,136 字节，约 33.34 KiB | 本地历史产物，不等于本次失败图片的线上传输证据 |
| `tmp/balanced-540/video2/cover.webp` | 49,842 字节，约 48.67 KiB | 同上 |

20 张这种体积的图，压缩传输合计约 0.65–0.95 MiB，并不是几个 GB；但每张 1280×720 图按 RGBA 展开约 3.52 MiB，20 张约 70 MiB，实际浏览器占用还受解码策略和其他开销影响。**下载体积、解码内存和网络等待是不同问题。静态封面没有视频帧率，降低视频 FPS 不会直接降低封面体积。**

### 2.7 已确认：难度映射仍不是用户要求的考试标签

`shared/content-taxonomy.js` 仍把 A1–C2 映射成“英语入门、基础交流、日常进阶、中高阶理解”等；首页和合集调用该映射。不能只修改首页按钮文本，必须让 AI、管理端保存、发布目录和学员筛选共用一份结构。

## 3. Code review 的两个审查轴

本次按 code-review 的 Standards 与 Spec 分开记录；由主审完成，不新增子代理。仓库缺少技能预期的 `docs/agents/issue-tracker.md`，本次采用用户截图、明确要求、功能板块文档和现有实现说明作为规格依据，不因此安装或初始化额外项目。

### Standards：规则与实现一致性

1. **目录引用完整性缺口：**视频转码会切换有效任务，但合集保存的任务 URL 未同步维护。归属 M03/M08 的共享内容契约；应建立可解析的稳定引用，而非放开所有旧任务的媒体权限。
2. **错误语义混用：**封面分支把会话缺失与服务故障同报 503，妨碍 M01 准入结果被正确消费。必须分开身份、权限、资源和服务异常。
3. **可能的 Shotgun Surgery，属于设计判断：**封面在首页、合集、发现、创作者等多个模板中独立拼接，加载策略不一致。仅把封面渲染及恢复收敛为共享契约，不借此重写整个 `app.js`。

此轴共 3 项，其中第 3 项是可维护性判断，不冒充硬性代码规范违规；最高优先级为引用完整性。

### Spec：用户目标兑现情况

1. 首页未落实选中的双列小图视频书架。
2. 更多菜单、偏好弹层未完整继承雾蓝深浅主题与紧凑组件规范。
3. 图片失败缺少可靠恢复和不挤占布局的降级显示。
4. 四级、六级、雅思、托福标签未贯穿发布数据及学生端。

此轴共 4 项，最高优先级为图片可用性与页面设计落地。不能用“测试通过”替代规格验收。

## 4. 实施顺序与修改边界

| 顺序/任务 | 主板块 | 允许修改的文件/契约 | 完成产物 |
|---|---|---|---|
| T01 当前封面定位 | M03/M04 | 当前发布目录、媒体 GET/HEAD、授权与对象元信息，只读 | 每个失效封面的状态码、引用、资源是否存在及耗时 |
| T02 封面身份与恢复 | M04，消费 M01 | `shared/cloud-content.js`、媒体路由、目录渲染入口 | 会话分类、独立续期、有限重试；不改变 VIP 规则 |
| T03 合集稳定引用 | M03，依赖 M07/M08 | 发布目录规范化、管理端合集字段、新增迁移、转码提交契约 | 自动封面随视频更新，自定义封面保持原样 |
| T04 缩略图 | M08，依赖 M03/M04/M07 | `media_tools.py`、Worker 输出清单、回执验证、路由白名单、图片元数据 | 320/640/960 缩略图、可兼容旧封面 |
| T05 首页与发现 | M02/M03 | `app.js` 页面组合、`app.css` 对应作用域、共享卡片 | 双列小图、真实计数、原入口可达 |
| T06 播放器视觉补齐 | M04 | `shared/mobile-player.js`、`index.html` 偏好结构、播放器 CSS | 更多/偏好/模式图标及两主题实装 |
| T07 难度贯通 | M03，依赖 M07/M08 | `content-taxonomy.js`、处理结果 schema、管理端与目录映射 | 一份标签枚举、真实发布数据、可用筛选 |
| T08 验收 | M10 | 针对受影响契约的 `audit/` 测试、截图和发布证据 | 明确通过项与尚未验证项 |

不修改邀请码、注册、续费规则；不重置学习进度；不自动批准旧教学草稿；不重编码已经合格的 540P 视频；不清理 R2 媒体。只为图片新增必要产物。

## 5. 图片链路：先恢复正确，再降低流量

### 5.1 T01：按证据区分失败原因

使用有效 VIP 的真实浏览器会话记录失败封面：页面来源、collectionId/videoId、URL、HTTP 状态、Content-Type、Content-Length、Cache-Control、Server-Timing、边缘 HIT/MISS。日志不包含令牌、Cookie 或完整个人信息。

| 结果 | 含义 | 行动 |
|---|---|---|
| 401 | 目录票据缺失/过期 | 合并刷新票据一次，重试当前图片 |
| 403 | VIP/发布状态/当前任务引用等条件不符 | 核查业务原因；禁止靠循环刷新或开放旧任务解决 |
| 404 | 已授权的目标对象不存在 | 固定占位，向管理端记录缺失资源，按源视频重建 |
| 503 | 权限依赖或服务暂不可用 | 有限退避；记录 requestId 与失败阶段 |
| 200 但图片解码失败 | 类型、空内容、损坏或编码兼容问题 | 校验实际字节和 MIME，不能归咎会员 |
| 200 且 authorization 慢 | 权限路径耗时 | 优先测 RPC，不先提高压缩率 |
| 200 且 delivery/下载慢 | 回源、体积、网络 | 检查缓存与响应式资源选择 |

### 5.2 T02：正确区分票据错误与服务故障

媒体路由的封面分支按以下结构调整，复用现有封装，并保留路径、对象回执与权限验证：

```js
// 拟议替换封面分支，不是绕过 service_resolve_playback_access_v2。
let ticket;
try {
  ticket = await openPlaybackTicket(
    cookieValue(request, 'eastudy_catalog'), env, 'eastudy-catalog'
  );
} catch {
  return json({ error: 'CATALOG_SESSION_REQUIRED' }, 401);
}
if (typeof ticket.sub !== 'string' || !ticket.sub) {
  return json({ error: 'CATALOG_SESSION_REQUIRED' }, 401);
}
let access;
try {
  access = await serviceRpc(env, 'service_resolve_playback_access_v2', {
    p_user_id: ticket.sub, p_job_id: job, p_path: path
  });
} catch {
  return json({ error: 'PLAYBACK_AUTH_UNAVAILABLE' }, 503);
}
if (access?.canPlay !== true) {
  return json({ error: access?.reason || 'PLAYBACK_FORBIDDEN' }, 403);
}
key = String(access.objectKey || '');
// 后续继续使用现有 R2 读取、404 和响应处理。
```

还需检查 `openPlaybackTicket` 的错误类型：如果函数将环境密钥配置错误与票据无效混在一起，实施时先拆分配置故障为 503，不能把服务配置错误永久伪装为 401。

目录与播放的状态分开：

```js
// 新内部状态设计示例；不是当前已存在的接口。
const lanes = new Map();
function mediaLaneKey({ scope, userId, kind }) {
  return `${scope}:${userId}:${kind}`; // kind: catalog | playback
}
// 每个 lane 保存 activeJobId、expiresAt、generation、timer、inFlight。
// catalog 无 activeJobId；playback 同时只有一个活动视频任务。
// 换视频只废弃 playback 的旧 generation，不清除 catalog 的续期。
// 退出/换账号：两条 lane 都取消、清 Cookie、丢弃旧请求的回调。
```

要求：进入首页/发现前等待目录票据就绪；按服务端真实到期时间提前续期；页面转前台时先校验；同一账号目录刷新 single-flight。权限到期停止刷新并消费 M01 的结果，不能给目录自行增加 VIP 宽限时间。

注意 Cookie 由浏览器在响应到达时写入，不能只检查 JS generation 就宣称换账号竞态解决。应沿用并验证现有退出时等待在途请求及后续清 Cookie 的策略；不同账号发证顺序需要串行/清理，测试延迟响应覆盖新会话的场景。

### 5.3 图片失败恢复的最小状态机

新增共享 `EastudyImages` 图片适配器，供首页/发现/合集/创作者调用；不要在每张卡里复制一套 `onerror`。

```text
idle → session-ready → loading → ready
                           └→ error → classify
401 → single-flight renew → retry once
403 → stop + consume access/catalog error
404 → fixed placeholder + report missing reference
503/network → limited retry → placeholder + manual retry
decode failure → placeholder + diagnostic
```

原生 `<img>` 的 error 事件拿不到 HTTP 状态码。正常路径使用 `srcset` 直接加载，失败后才对 `img.currentSrc` 发同源 HEAD 请求分类；核对当前图片 identity，避免页面换卡后旧请求回写。HEAD 也要使用相同鉴权，不把失败诊断误认为成功。网络/CORS 导致 HEAD 不可用时归为未知网络错误，不能猜 401。

每个 image identity 的 401 最多刷新一次，503/网络最多两次退避（例如 0.8s、2s 并带抖动）；全页面续期合并、失败诊断限制并发，页面销毁取消。重新赋值 URL 不添加随机时间戳；先清空后恢复 src/srcset，或替换图片节点。只有明确的内容版本变化才变 URL。

占位图与加载态保持同样的 16:9 尺寸，用轻量本地 SVG/纯色；不显示浏览器破图和大段错误，不拿无关风景当真封面。卡片仍保留标题及合法导航；严重身份错误由统一入口提示。

### 5.4 T03：合集封面从临时任务 URL 改为稳定内容关系

新增兼容字段，保持旧 `cover` 供老客户端回退：

```json
{
  "id": "1001",
  "coverSource": { "type": "video", "videoId": "1788926081632" },
  "cover": "/api/processing/media/CURRENT_PUBLISHED_JOB/cover.webp"
}
```

上例占位 JOB 不是可用 URL。服务器序列化发布目录时，只从该合集实际已发布成员中查找 videoId，并解析它的当前封面。自定义封面使用另一种明确关系：`{type:'asset', assetId:'…'}`，沿用/补齐管理端合法图片资源契约，不能套进任意处理任务。

迁移步骤：

1. 只读导出当前草稿、发布快照及 revision；列出旧任务 URL → 所属 videoId → 当前任务关系。不能根据标题或数组位置猜归属。
2. 仅对能证明来源且属于该合集的自动封面建立 `coverSource`；自定义上传保持不动，不能确认的交管理端选择。
3. 新增前向迁移/RPC，事务内锁定当前内容行，校验预期 revision；分别更新必要的草稿/发布合集字段，禁止整份草稿覆盖发布内容。
4. 修复转码提交/目录解析，使后续任务切换无需手工追逐旧 URL。
5. 成员下架/删除时选择合法剩余成员或空占位；不引用回收站视频。
6. 保留变更清单与修改前值；回滚按字段及 revision 执行，不恢复整库。

禁止通过“任何 REVIEW 任务都允许访问”、管理端媒体 URL、公开 R2 桶来掩盖旧引用问题。

### 5.5 T04：为小卡生成真实缩略图

建议静态 WebP 变体；尺寸为横向 16:9 的上限，保留比例，不放大低分辨率源图：

| 变体 | 目标用途 | 编码预算目标，不是保证值 |
|---|---|---|
| 320×180 | 低 DPR/低流量卡片 | ≤20 KiB |
| 640×360 | 常见高 DPR 双列手机卡片 | ≤45 KiB |
| 960×540 | 大屏/播放封面 | ≤80 KiB |

质量从 75 左右开始，用真实人脸、场景、字幕烧录画面检查；达不到字节预算时按质量下限做有限调整，不为了小文件制造明显马赛克。现有 33/49KiB 并不一定每张都有巨大压缩收益，应比较实际生成结果。

```python
# 拟议处理器片段：输入为已验证的本地封面，不改变视频 FPS。
# subprocess.run(argv, check=True)；不得用用户字符串拼 shell 命令。
argv = [
    "ffmpeg", "-y", "-i", source_cover,
    "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
           f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
    "-frames:v", "1", "-c:v", "libwebp", "-quality", "75", output_file
]
# width,height 来自服务端固定规格；低分辨率输入先限制目标尺寸。
```

新产物建议 `covers/320.webp`、`covers/640.webp`、`covers/960.webp`，保留旧 `cover.webp` 兼容。**当前路由只接受 cover.webp，新路径不能只改前端。** 必须同步：Worker 产物清单、上传回执 schema、SQL 已验证路径检查、读取白名单、发布图片元数据、持久删除清单与共享引用保护。旧已执行迁移不编辑。

目录发布结果新增图片契约示例：

```js
// URLs 必须由服务端根据已验证 manifest 生成；revision 为目录/产物版本。
coverImage = {
  revision: 'server-issued-version',
  fallback: '/api/processing/media/VALID_JOB/cover.webp',
  variants: [
    { width: 320, height: 180, bytes: 18000, url: 'SERVER_APPROVED_URL_320' },
    { width: 640, height: 360, bytes: 38000, url: 'SERVER_APPROVED_URL_640' }
  ]
};
```

实际 HTML 通过 DOM API/转义函数填入服务端 URL。不能凭空给旧链接加 `?w=320`，目前没有这项图片变换服务。

```html
<!-- 拟议结构：下面的占位 URL 必须由已发布契约替换 -->
<img width="640" height="360" alt="视频标题"
     src="APPROVED_640_URL"
     srcset="APPROVED_320_URL 320w, APPROVED_640_URL 640w, APPROVED_960_URL 960w"
     sizes="(max-width: 520px) calc((100vw - 34px) / 2), 240px"
     loading="lazy" decoding="async">
```

以上 sizes 只适用于本文双列卡，不适用于横向继续学习或全宽播放器；各位置按真实渲染宽度传 sizes。首屏可见图用 eager，主要 LCP 图最多一个使用 `fetchpriority="high"`，屏外用 lazy；不能所有图一律 lazy，也不能全设 high。分批追加卡片，避免一次创建数百张图。

缓存先保守处理：维持会员授权后才能读媒体，继续使用版本化对象的边缘缓存；本轮不直接把私人封面改成 public 浏览器长缓存。长期浏览器缓存与会员撤销即时性有冲突，必须单独定义规则才可修改。刷新加速先靠正确引用、目录缓存、图片尺寸和鉴权耗时治理，不能承诺换格式就解决跨地域慢链路。

## 6. 首页与发现页：同一套雾蓝双列小卡

### 6.1 信息顺序

首页：紧凑标题/主题入口 → 搜索 → 有历史时才出现的一张横向“继续学习” → 单行可横滑分类 → 双列视频书架 → 常驻主导航。

删除手机首页重复展示同一批视频的“每日精选/推荐/最新”多块堆叠，合并成书架的筛选或排序；不是删除视频、学习记录或数据。无继续学习记录时整块不占位。学习统计集中在“我的”，收藏/生词保留原入口。

发现页：保留合集、创作者检索与筛选；合集采用相同双列缩略图规范，标题及真实视频数。首页和发现是两个渲染入口，必须分别截图验收。

底部保留现有“视频 / 发现 / 生词 / 我的”四个业务入口，统一外观；参考图是三项也不能直接删掉发现功能。

### 6.2 卡片几何

适用 320–520 CSS px 的正常手机显示；高倍文字缩放导致有效视口不足 320 时允许单列可读降级。

| 参数 | 数值 |
|---|---:|
| 页面左右内距 | 12px |
| 列间距 / 行间距 | 10px / 14px |
| 列数 | 2，`minmax(0, 1fr)` |
| 320 / 390 / 430 屏宽对应卡宽 | 143 / 178 / 198px |
| 封面比例 | 16:9；对应高度约 80.4 / 100.1 / 111.4px |
| 卡片圆角 | 12px |
| 标题 | 14px / 行高 20px，最多两行；完整标题仍可访问 |
| 作者、时长、难度 | 11–12px / 行高 16px |
| 横向继续学习卡 | 缩略图宽 96px、16:9；剩余区域标题和进度 |
| 主导航 | 内容高 52px + 设备底部安全区 |

```css
/* 拟议规则：替换冲突旧规则，不能继续叠加 !important 补丁。 */
@media (min-width: 320px) and (max-width: 520px) {
  #mobileVideoList,
  #collectionsBrowseGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 10px;
  }
  .mobile-library-section { padding-inline: 12px; }
  .mobile-library-section article { min-width: 0; }
  .mobile-library-section .card-cover {
    width: 100%; aspect-ratio: 16 / 9; overflow: hidden;
    border-radius: 12px; background: var(--ui-selected);
  }
  .mobile-library-section .card-cover img {
    display: block; width: 100%; height: 100%; object-fit: cover;
  }
  .mobile-library-section .card-title {
    margin: 8px 0 4px; font-size: 14px; line-height: 20px;
    display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere;
  }
}
```

`.mobile-library-section`、`.card-cover`、`.card-title` 是拟新增明确作用域；需同时接入真实模板，不是孤立 CSS。卡片主入口用链接/按钮或完整键盘语义，卡内收藏等不能冒泡误开视频。图片裁切只用于封面，不用于视频播放画面。

## 7. 播放器：保持紧凑布局，把 UI 补齐

### 7.1 不改动已经确认的正常竖屏骨架

```js
// 沿用已验收的几何，T/B 从真实 safe-area 获取。
const H = Math.round(window.visualViewport?.height || innerHeight);
const W = videoPage.clientWidth;
const videoHeight = Math.max(64, Math.min(W * 9 / 16, H * .42, H - 300));
const headerHeight = 44 + T;
const modeHeight = 44;
const dockHeight = 112 + B;
const dockTop = H - dockHeight;
const transcriptTop = headerHeight + videoHeight + modeHeight;
```

390×844、T=0、B=34 示例：

| 区域 | y 起点 | 高度 | 规范 |
|---|---:|---:|---|
| 标题 | 0 | 44 | 返回/标题/主题；图标点击区 44×44 |
| 视频 | 44 | 219.375 | 宽 390；`object-fit:contain`，无页面左右留白 |
| 展开练习模式 | 263.375 | 44 | 连续播放/逐句暂停/单句循环/听写填空 |
| 字幕滚动区 | 307.375 | 390.625 | 底边到 698，不被底栏遮挡 |
| 进度 | 698 | 24 | 保留防误触逻辑 |
| 播放操作 | 722 | 44 | 倍速/盲听/上一句/播放/下一句/更多 |
| 学习工具 | 766 | 44 | 重点词/生词本/已学/视频目录 |
| 安全区 | 810 | 34 | 按设备值，不硬编码固定34 |

正常竖屏视频框占满内容宽度；非 16:9 素材 `contain` 必然可能有黑边，不能为了“满屏”拉伸或裁掉教学画面。横屏继续保留已实现的分栏方案，不强行套上述纵向坐标。

### 7.2 组件视觉与真实业务映射

| 组件 | 可见尺寸/样式 | 点击后行为 |
|---|---|---|
| 普通图标 | 18×18、viewBox 24、stroke 1.7、禁止 flex 压扁 | 沿用现有业务 handler |
| 播放 | 圆形 32×32；外部点击盒至少 44×44 | 原视频播放/暂停，媒体事件回写图标 |
| 模式按钮 | 总行高44；每格 `(W−28)/4`；图标14+标签12，可控间距 | 原 `setPracticeMode`，选中态用淡蓝胶囊而非只画底线 |
| 盲听 | 与普通按钮一致；明确选中背景 | 隐藏字幕，再次点回到之前字幕设置 |
| 重点词 | 图标18、标签与真实去重计数 | 当前视频已发布重点词；不硬编码499 |
| 生词本 | 图标18、当前账号计数 | 原云端生词数据；未加载不伪造0 |
| 视频目录 | 不写“1/2”替代名称 | 打开队列；上一条/下一条视频，不与上一句混淆 |

可见按钮可以小，触控盒不做成 18px。SVG 的 width/height 固定、`flex:none`，播放圆钮 `aspect-ratio:1`，禁止不等比缩放。英文字幕默认17px/1.6、中文13px/1.55，仍尊重用户字号设置；不在句下加说明或三个点。

重点词颜色不变；短语父元素整体下划线、逐词子元素只改变播放背景。不得恢复跨行定位矩形或播放时统一黑字。

### 7.3 更多菜单：紧凑菜单式面板

标题仅“更多”，右侧关闭图标；上方不加产品说明。菜单位于底栏上方 8px，宽 `min(420px, 100vw − 16px)`；标题行44、普通行44–48，内部长内容滚动，不撑开播放器。

排列及映射：

1. “字幕显示”：双语 / 英文 / 中文 / 关闭四段选择，映射原字幕模式；保留“盲听”独立入口与恢复语义。
2. “复制此句”：复制打开菜单时锁定的句子；无句子则禁用。
3. “收藏此句”或“取消收藏”：根据当前账号状态显示其一，不显示“收藏 / 取消收藏”并列说明。
4. “上一条视频 / 下一条视频”：紧凑同一行，依据队列边界禁用；视频目录常驻按钮仍保留。
5. “界面语言”：中文 / English，映射界面语言，不混同字幕语言。
6. “学习偏好”：进入同一面板的设置子页，返回回到更多，不叠两套遮罩。

行左侧统一线性图标；必要的当前值右对齐。取消大块紫色填充、粗边框、重复解释与演示句按钮。不新增“当前句解析”或手机音量滑块。

```css
/* 示意：dialog 的定位要覆盖原生居中 margin，弹层内部独立滚动。 */
.lesson-sheet {
  position: fixed; inset: auto 0 calc(var(--player-dock-height) + 8px);
  margin: 0 auto; padding: 0;
  width: min(420px, calc(100vw - 16px));
  max-height: max(44px, min(65dvh, calc(var(--player-vh) - var(--player-dock-height) - 16px)));
  border: 1px solid var(--ui-line); border-radius: 16px;
  color: var(--ui-text); background: var(--ui-panel);
  overflow: auto;
}
.lesson-sheet .menu-row {
  display: flex; align-items: center; gap: 10px;
  min-height: 44px; padding: 8px 12px; box-sizing: border-box;
}
.lesson-sheet svg { width: 18px; height: 18px; flex: none; }
```

`--player-vh` 和 `--player-dock-height` 必须接入实际几何值及横屏规则。使用 native dialog 或等效完整焦点管理：可访问名称、Escape/关闭、焦点回到更多按钮、背景 inert；设置子页不让父弹层遗留在 top layer。软键盘和短横屏时按可视视口重新限高。

### 7.4 学习偏好：所有设置先做功能清单再缩排

实施前枚举 `index.html` 当前偏好控件与 handler，一项一项建立旧 ID → 新控件 → 保存字段映射。不可为了简洁删除实际的字号、播放/循环等已有设置。

主区显示常用设置，每行“名称 + 当前值/分段开关”，高度44–48；低频项放“高级设置”可展开区域。移除重复编号、教学演示文案和没有业务作用的预览按钮。已有字体配置必须继续影响字幕，并保留云端偏好合并及失败恢复逻辑。

### 7.5 两个主题共用组件，不污染重点词颜色

| Token | 浅色 | 深色 |
|---|---|---|
| bg | `#F7FAFE` | `#111C2A` |
| panel | `#FFFFFF` | `#172536` |
| text | `#17263D` | `#E8EFF8` |
| muted | `#536983` | `#A3B5CC` |
| line | `#DCE5EF` | `#2D4057` |
| brand | `#4C82B8` | `#85B7E7` |
| action | `#346DA5` | `#85B7E7` |
| selected | `#E8F1FA` | `#243D57` |

把 token 注入首页、播放器、dialog 的共同 UI 作用域；不要只定义在 `#videoPage` 内导致 body 下的偏好弹层用旧色。重点词语义颜色使用原变量，不被 `button/span {color:…}` 全局覆盖。普通文字、选中态、禁用态分别验对比度。

本轮不必重新生成整页概念图。用已选参考图建立可点击 HTML，输出“实际 DOM”的浅色/深色首页、发现、正常播放、盲听、更多、偏好截图。若需要补新图，只补更多/偏好的缺失状态，图形规范保持本节数值；生成图不能代替功能成品。

## 8. 难度：四级、六级、雅思、托福的端到端映射

这四项是面向学习者的内容适配标签，不是可严格排列的同一考试等级尺。不能写死 B2=雅思、C1=托福；雅思和托福也不能说一个必然比另一个难。

新增兼容字段，保留已有 CEFR 供内部计划使用：

```js
const TRACK_LABELS = Object.freeze({
  cet4: '四级', cet6: '六级', ielts: '雅思', toefl: '托福'
});
// video.difficulty，新增契约：
// { primaryTrack, targetTracks, reviewStatus, evidence, schemaVersion: 1 }
function learnerDifficultyLabel(video) {
  const d = video.difficulty;
  if (!d || d.reviewStatus !== 'approved') return '';
  return TRACK_LABELS[d.primaryTrack] || '';
}
```

`approved` 由管理端审核或明确的自动校验流程置入，不信任 AI 自己写 approved。卡片只展示一个主标签；筛选使用规范化 targetTracks，可让适合两种考试人群的视频被两边找到。不能把前端中文字符串当数据库 ID。

给 DeepSeek 的新增要求：

```text
依据完整逐字稿、实际语速、词汇/习语难度、句法复杂度、话题抽象程度，
为具备四级及以上基础的成人学习者评估适配方向。
primaryTrack 只允许 cet4/cet6/ielts/toefl/null；targetTracks 为上述非 null 值的去重数组。
不要将雅思/托福当成线性高低等级，不得从单个单词推断整段难度。
输入无语速数据时明确缺失，不编造；证据不足返回 null 及待审核原因。
evidence 引用原稿具体句段，说明词汇、句法、话题和语速依据。
适配四级以上不等于每句强制提取重点词：不要把 and then、i just know、
we love you 等普通片段为凑数量当成高级短语。
不输出用户可见的审核状态，不自行批准结果。
```

后端校验枚举、数组去重、主标签是否在 targetTracks、证据合法性；管理端可修改，并通过原发布流程进入目录。首页/合集/创作者/搜索/视频目录共用映射。旧视频先生成候选并核对，再定点发布难度字段；不把其他未审批教学草稿一并发布。未评估完成时暂不显示难度徽标，不伪装成四级，也不在卡片加“建设中/测试中”。

## 9. 验收：功能通过与视觉通过分别取证

### 9.1 必须覆盖的场景

| 范围 | 验收场景 | 通过条件 |
|---|---|---|
| 图片引用 | 转码前后同一合集、成员下架、自定义封面 | 不继续指向失效任务；不覆盖自定义图；仅合法已发布成员 |
| 票据 | 首次进入、超过5分钟、后台返回、换视频、换账号 | 目录/播放续期互不取消；账号数据无串用 |
| 图片错误 | 401/403/404/503/解码失败/离线恢复 | 分类正确、有界重试、无请求风暴、固定占位 |
| 权限 | 有效VIP/过期VIP/未登录/管理员 | 与原 M01 规则一致；不能因缓存越权 |
| 图片尺寸 | 320/390/430宽，DPR1/2/3 | currentSrc 合理；不一律下载1280图；不重复下载多个变体 |
| 首页/发现 | 深浅色、空数据、1/2/多条、长中英文标题 | 正常手机双列，真实数量，无虚构填充；无横向溢出 |
| 播放器 | 四种练习、盲听、上一条/下一条、字幕滚动 | 原能力保留，模式状态和实际播放一致 |
| 更多/偏好 | 复制、收藏、字幕、语言、设置返回、Escape | 按钮一一映射，焦点/背景/滚动正确，不双遮罩 |
| 重点词/生词 | 深浅主题、逐词播放、短语换行、账号切换 | 颜色稳定、整体短语下划线、真实去重计数 |
| 难度 | AI候选→管理修改→发布→学生显示/筛选 | 四处为同一字段；不误用CEFR硬映射 |

视口至少：320×568、360×800、390×844、430×932、768×1024、844×390、1280×800；两主题均测。增加真实 iOS Safari、Android Chrome，用户实际微信内打开时再测微信浏览器；桌面模拟不替代真机结论。

### 9.2 视觉验收交付物

每个状态提供：参考图、真实 DOM 截图、尺寸测量、未对齐项。必须含首页、发现、正常播放、盲听、更多、偏好各深浅两张，共至少12张。不使用生成图充当运行截图，不以空视频占位图证明真实播放正常。

核查视频全宽、卡片双列、图标不变形、各栏高度、字号、主题、短语颜色、底栏不遮挡字幕、长文字与200%文字缩放。用户放大文字时以可操作/可滚动为先，不强行锁死所有行高导致裁字。

### 9.3 加载预算与测量

在固定设备、相同页面数据、记录清楚的网络条件下比较修复前后，区分冷启动、暖缓存、会话过期后重新进入。记录 p50/p95；少量样本不能代表所有地区。

- 目标：图片自身导致的布局偏移为0；整体页面 CLS≤0.1。
- 目标：首屏封面选中资源合计≤300KiB，以真实瀑布图计算，不包含视频流。
- 目标：普通在线进入无破图；过期票据可恢复，不需要用户整页刷新。
- LCP以移动端2.5秒为优化目标；若鉴权或跨地域链路达不到，报告分段耗时和下一步，不伪造通过。
- 失败重试数、鉴权调用数、下载字节、解码尺寸必须同时记录，防止“重试到成功但流量倍增”。

### 9.4 代码检查

新增有意义的契约/回归用例：目录与播放独立续期、换账号延迟响应、旧合集引用修复、合法缩略图回执、路径穿越拒绝、403不得刷新循环、深浅UI绑定和真实难度筛选。按仓库现有测试方式接入，不为了断言实现细节堆快照。

受影响板块运行 `npm run test:m01`、`npm run test:m04`、`npm run test:m08`、`npm run test:module-boundaries`；最后运行发布规定的 `npm run test:all`、语法检查与 `git diff --check`。数据库验证使用隔离/回滚测试，生产只做受控只读及已授权修复检查。

## 10. 后续执行、发布和恢复

1. 本文获准实施后，先保存当前内容 revision 与精确字段备份，完成 T01，明确截图失败究竟是过期票据、旧引用还是对象缺失。
2. 本地完成 T02/T03，优先恢复图片正确性；再接入 T04，保持旧 cover.webp 客户端可用。
3. T05/T06 以已有选定设计为准实装，提供真实本地页面与12张验收图；不再绕回多轮整页概念图。
4. 完成 T07 候选审核与字段定点发布准备；不顺带批准旧的整份教学草稿。
5. 发布前再按固定基线做 Standards/Spec 双轴 review，关闭会造成图片失效、越权、播放器主功能中断和数据覆盖的问题，保留未验证项清单。
6. 遵循仓库唯一发布顺序：验证新的 Supabase 迁移 → main 快进/push → Cloudflare 连接 Git 部署 → HTTPS 与可用浏览器检查。没有数据库变更也要记录“无迁移”，不省略版本核对。
7. 当前这轮仅输出方案，不执行上述线上步骤。后续发布必须对实际发布版本、构建产物和最新内容 revision 取证。

恢复：保留 `faf9ef3` 前端作为恢复点；新图片契约和数据库字段采用向后兼容扩展，必要时先恢复前端，新增缩略图可保留。数据修复按备份字段和预期 revision 撤回，避免覆盖后来管理端编辑。不删R2、不清缓存目录、不重置工作区。新增图片不通过本次发布直接物理删除，生命周期交由既有持久删除流程。

完成定义：问题对应代码、数据、功能和视觉验收全部有证据；剩余真机/网络限制如实说明。任何一次 code review 都不能保证所有设备和未来所有输入“零Bug”，但不能把已知缺口以“已完成”交付。

## 11. 参考资料与研究限制

本次核对了公开官方文档，采用可验证的浏览器加载机制，没有声称读取竞品服务端源代码或本次成功实测其已登录页面。竞品布局依据用户提供的截图；浏览器登录页面/按钮实测受此前连接器认证问题影响，未完成的部分不作为证据。

- MDN img：`srcset/sizes`、尺寸占位与 fetchpriority：<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img>
- web.dev 浏览器原生图片懒加载：首屏/LCP不应懒加载，屏外再 lazy：<https://web.dev/articles/browser-level-image-lazy-loading>
- Cloudflare Workers Cache API：数据中心本地缓存及响应缓存限制：<https://developers.cloudflare.com/workers/runtime-apis/cache/>
- 项目板块规则：`docs/FUNCTIONAL_MODULES.md`。
- 已发布播放器尺寸和验证边界：`docs/design/player-blue-spec-20260916/IMPLEMENTATION.md`。

图片视觉对照采用 PrismForge 的诊断流程；没有新生成设计图片。代码审查采用 code-review 的双轴方法，图片加载机制与视觉偏差分别取证，避免用美化掩盖通路故障。
