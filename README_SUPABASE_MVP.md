# Eastudy MVP 测试说明

## 已接入内容

- 学员入口：网站首页 `/`；独立登录页 `/login.html`
- 管理员入口：`/admin/login.html`
- 登录方式：手机号加密码；验证码界面与客户端流程已经接通
- 验证码登录：首次验证成功后自动建立学员账号，之后仍可继续使用验证码
- 短信发送：上线前需要在 Supabase 配置短信供应商并启用手机号验证
- 学员数据：资料、学习进度、收藏句、生词状态、学习事件
- 权限：学员只能读写自己的数据；管理员才可以进入控制端和读取汇总数据

当前数据库的新学员角色名是 `learner`；前端同时兼容历史数据中的
`student`。两者都只属于学生端，`admin` 仍只允许进入独立管理端。

学生端和管理端使用不同的浏览器会话键：`eastudy-student-auth` 与
`eastudy-admin-auth`。同一浏览器中，两种账号不会互相借用登录状态。

执行基础迁移后，再执行 `supabase/migrations/20260907_otp_and_password_status.sql`。
该迁移记录手机号是否已验证、账号是否已激活以及是否设置过密码；密码本身始终由 Supabase Auth 管理。

## 开始测试

1. 打开 `https://english-web-lce.pages.dev/login.html`，或从首页登录弹窗进入独立登录页。
2. 在“学生注册”中创建一个学生账号。使用国际格式手机号和至少 8 位密码；配置短信供应商后，也可以使用验证码自动注册。
3. 进入任意视频，播放、暂停、收藏句子或保存词汇；刷新页面后，个人数据会从 Supabase 恢复。
4. 用另一个手机号创建准备作为管理员的账号。
5. 打开 Supabase SQL Editor，执行：

```sql
update public.profiles
set role = 'admin'
where phone = '+8613812345678';
```

将示例手机号替换为第 4 步的管理员账号手机号。

6. 打开 `https://english-web-lce.pages.dev/admin/login.html`，使用管理员账号登录。
7. 用学生账号访问 `/admin/` 时，会被送回管理员登录页；用学生账号在管理端登录也会被拒绝。

## 当前 MVP 范围

用户与学习统计已经保存在 Supabase。控制端的“视频、字幕、解析队列”仍沿用当前包体的本地内容演示层；多人共用内容库需要下一阶段把 `shared/content-store.js` 替换为 Supabase 内容表或服务端 API。

前端只使用 Supabase Publishable Key。Secret Key 不应放入网页、GitHub 或 Cloudflare Pages。
