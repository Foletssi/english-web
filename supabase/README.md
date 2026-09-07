# Supabase schema

This project already contained the following shared MVP tables:

- `profiles`: phone, nickname, role and membership fields;
- `user_progress`: per-video position and completion state;
- `saved_words`, `saved_sentences`, `daily_learning_stats`.

`migrations/20260907_mvp_auth_and_learning.sql` extends that model with
`study_events` and `user_vocabulary`, then applies row-level-security policies.
It deliberately keeps the existing tables and data intact.

New phone/password users receive the `student` role from the existing `auth.users`
trigger. Promote only the intended management account with the SQL shown in
`../README_SUPABASE_MVP.md`.

`20260907_otp_and_password_status.sql` adds learner activation and password-status
fields. Its self-service RPCs run only after Supabase accepts an OTP or password.
The password flag is informational; Supabase Auth remains the only verifier.

## Beta 6.22 会员激活

在前两份 MVP 迁移之后执行 `migrations/20260908_membership_activation.sql`。该迁移创建：

- `public.membership_entitlements`：学生只读自己的会员权益。
- 私有激活码批次、哈希和兑换审计表：浏览器无法直接读取。
- `redeem_activation_code(p_code)`：登录学生原子兑换；同一账号重试幂等。
- `admin_generate_activation_codes(...)`：仅 `profiles.role = admin` 的登录管理员可生成；原码只返回一次。

生成示例（仅在已登录管理员的 SQL/受保护管理端执行）：

```sql
select * from public.admin_generate_activation_codes('首批 30 天码', 30, 10, now() + interval '90 days');
```

不要把生成结果、`service_role` 或用户手机号提交到 Git。
