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
