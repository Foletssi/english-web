# M04 播放授权故障：2026-09-12

## 实测证据

- 当前生产基线：`1b650cd2a53491b832a22e1a3028d8a59bbf9ae0`。
- 使用已获授权的管理员账号调用 `learner-auth`：HTTP 200，`canPlay=true`、`canEnterLearning=true`。
- 已发布内容读取成功，目录中是两个视频。
- 两个视频分别调用 `POST /api/session`：均返回 HTTP 503、`PLAYBACK_AUTH_UNAVAILABLE`。
- 不带 jobId 的目录签票：HTTP 503、`PLAYBACK_TICKET_UNAVAILABLE`。
- 通过 Supabase 官方 CLI、只读 SQL，使用 service_role 声明执行忙碌一天视频的 `service_resolve_playback_access_v2`：成功，`canPlay=true`，返回 720P 清单的真实对象键。

因此已排除本次复现账号的密码/VIP拒绝和该视频数据库授权函数执行失败；故障位于 Cloudflare 播放授权调用、票据签发环节。不得仅凭 503 推断视频文件已丢失。

2026-09-12 后续生产实测：部署 `7690adf` 后，管理员调用 `GET /api/session` 返回 HTTP 503：`mediaBucket=true`、`authorizationCredential=false`、`ticketEncryption=false`。已确认 R2 绑定存在、`SUPABASE_SERVICE_ROLE_KEY` 未配置或为空、`PLAYBACK_TICKET_KEY` 缺失或不可用于 AES 加密。这是本次播放中断的直接配置原因。

## 本次代码修改边界

仅 M04 及其页面加载入口、专项测试：

1. `shared/player-state.js` 统一播放授权错误提示。服务故障不再错误引导重新登录；真实登录失效、VIP到期、权限拒绝分别提示。
2. `assets/js/app.js` 只调用上述公开的 M04 提示契约。
3. `GET /api/session` 新增管理员专用配置预检，只返回布尔状态，检查 R2 绑定、服务端授权凭据是否存在、AES密钥是否可用于加密。匿名返回 401、非管理员返回 403。
4. 仅为修改的两个前端资源更新缓存版本；不改其他板块版本。
5. 预检只是依赖检查，不代表凭据有效、会员裁决正确或视频可播放；必须继续做下面的真实媒体验收。

本次不修改账号、VIP、数据库业务记录，不运行媒体删除，不改变播放器清晰度，不将JWT放回Cookie，不放宽鉴权。

## 生产配置修复步骤

1. 登录 Cloudflare，仅检查 `english-web` 对应 Pages 生产项目，确认域名为 `english-web-lce.pages.dev`。
2. 保留全部现有配置和 R2 绑定，不覆盖整个配置对象。
3. 检查 Production 环境：
   - `SUPABASE_URL` 对应 `ehxqtgakjgqgmghhdmjg` 项目。
   - `SUPABASE_SERVICE_ROLE_KEY` 是该项目的服务端凭据，不是 publishable/anon key。
   - `PLAYBACK_TICKET_KEY` 为密码学随机生成的 32 字节 Base64URL 密钥。
   - `VIDEO_BUCKET` 绑定现有视频 R2 桶。
4. 只补齐或修正有证据异常的配置。密钥只放平台服务端 Secret；不写Git、前端或日志。已有有效密钥不要无故轮换。
5. 按仓库流程确认数据库迁移状态，再提交并推送 main，由 Git 集成构建。配置更新后也必须重新构建，使新配置进入运行实例。

## 验收门槛

- 本地：`npm run test:m04`、`node audit/player_loop_contract_test.mjs`、`npm run test:m01`、`npm run test:module-boundaries`、`npm run audit`、`git diff --check`。
- 线上管理员配置预检通过；错误凭据即使非空也不能用预检替代实际签票验证。
- 授权登录后，对两个已发布视频分别签票成功；短票据绑定 `sub/job/prefix/exp`，Cookie不包含Supabase JWT。
- 对两个视频读取真实 m3u8，并读取其中真实TS分片；验证清单格式及媒体字节，不能只检查首页HTTP 200。
- 无Cookie拒绝、跨视频使用票据拒绝、失效票据拒绝；会员失效应由M01裁决拒绝。
- 不修改真实用户的会员状态来制造测试结果。测试会话最后仅退出本次会话，不退出用户其他设备。
- Chrome连接器目前报 `unsupported Codex auth method: apikey`；可用已授权 HTTPS 备用通道，但不得声称完成了浏览器交互播放验收。

## 当前状态与恢复

本地上述专项测试通过。`7690adf` 已提交并推送 main，Cloudflare 页面资源及新增配置检查已确认上线。
用户已通过 Chrome 授权并提供成功截图。官方 Wrangler 4.131.0 的回调服务器在授权交换完成、跳转成功页后等待一个 Chrome 本机连接关闭，导致凭据保存延迟。用户退出 Chrome 后官方 CLI 确认登录成功，无需再次授权。
已通过 Cloudflare Pages API 在生产环境补齐 `SUPABASE_SERVICE_ROLE_KEY` 和 `PLAYBACK_TICKET_KEY`，两者均为 `secret_text`；前者取自本 Supabase 项目的官方 CLI，已用真实 RPC 验证有效；后者为新生成的随机 32 字节 Base64URL 密钥。整个过程不输出或提交密钥。更新后确认 R2 绑定与 Preview 环境均未变化。下一步通过 main 推送重新构建，再做真实视频清单和分片验证；配置存在不能替代播放验收。
数据库迁移列表与远端一致，dry-run确认没有待执行迁移。Git连接曾重置，使用 HTTP/1.1 重试后正常推送。Git基线可用于代码回退，但基线本身存在本次播放故障，不应把回退当作播放恢复。
