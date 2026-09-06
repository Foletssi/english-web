# Eastudy Beta 6.19

- 移除学生端可见的管理员登录入口。
- 新增独立学生登录页 `/login.html`，沿用 Eastudy 登录视觉并连接 Supabase 手机号密码认证。
- 学生登录页只接受 `student` 角色；管理员入口继续独立位于 `/admin/login.html`。
