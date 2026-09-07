# Eastudy Beta 6.22.0

## 已完成

- VIP 改为 Supabase 服务端真实权益，不再由前端 localStorage 或演示 CDK 决定。
- 新增一次性激活码、管理员批量生成、原子兑换、续期和 RLS 隔离。
- 普通学员默认不显示 VIP；昵称保留完整内容并提供悬停全文。
- 离开视频路由、切换到后台、退出登录或关闭页面时统一停止视频、TTS、录音和回放。
- 修正学习完成弹窗，显示真实观看百分比和本次新增收藏。
- 增加英音/美音选择以及单词、生词本、原句跟读发音链路。
- 增加完整学习目标体系；已有内容标记“可开始学习”，未制作路线明确标记“规划中”。
- 学习目标和每日时长按学生账号隔离保存在当前设备。

## Supabase

按顺序执行：

1. `supabase/migrations/20260907_mvp_auth_and_learning.sql`
2. `supabase/migrations/20260907_otp_and_password_status.sql`
3. `supabase/migrations/20260908_membership_activation.sql`

前端仅包含 publishable key。激活码原文只在管理员生成函数的返回结果中出现一次。
