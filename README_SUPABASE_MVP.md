# Eastudy MVP 测试说明

## 已接入内容

- 学员入口：网站首页 `/`
- 管理员入口：`/admin/login.html`
- 登录方式：手机号（国际格式，例如 `+8613812345678`）加密码
- 手机号确认：已关闭，不会发送短信验证码
- 学员数据：资料、学习进度、收藏句、生词状态、学习事件
- 权限：学员只能读写自己的数据；管理员才可以进入控制端和读取汇总数据

学生端和管理端使用不同的浏览器会话键：`eastudy-student-auth` 与
`eastudy-admin-auth`。同一浏览器中，两种账号不会互相借用登录状态。

## 开始测试

1. 打开 `https://english-web-lce.pages.dev`。
2. 在“学生注册”中创建一个学生账号。使用国际格式手机号和至少 6 位密码。
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
