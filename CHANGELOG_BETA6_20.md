# Eastudy Composite V1 Beta 6.20

- 管理端新增独立登录门，使用 `zs:admin:sessionActive`，与学生端会话完全分离。
- 管理端直达 `/admin/` 先进入登录页；退出后重新回到管理端登录门。
- 学生端会话不会解锁管理端，管理端会话也不会改变学生端登录状态。
- 本地演示账号：`admin@eastudy.local` / `Eastudy#2026`。
