-- Eastudy MVP extension for the existing Supabase project.
-- It preserves the existing profiles, user_progress, saved_words, saved_sentences
-- and daily_learning_stats tables. Run this script in the Supabase SQL Editor.

create table if not exists public.study_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 80),
  video_id bigint,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table if not exists public.user_vocabulary (
  user_id uuid not null references public.profiles(id) on delete cascade,
  word_key text not null,
  word text not null,
  phonetic text not null default '',
  meaning text not null default '',
  context text not null default '',
  state text not null default 'new' check (state in ('new', 'review', 'mastered')),
  correct_streak integer not null default 0 check (correct_streak >= 0),
  added_at timestamptz not null default now(),
  last_reviewed_at timestamptz,
  next_review_at timestamptz,
  primary key (user_id, word_key)
);

create index if not exists study_events_user_time_idx on public.study_events (user_id, occurred_at desc);
create index if not exists study_events_type_time_idx on public.study_events (event_type, occurred_at desc);
create index if not exists user_vocabulary_review_idx on public.user_vocabulary (user_id, next_review_at);

alter table public.study_events enable row level security;
alter table public.user_vocabulary enable row level security;

drop policy if exists "study events select own or admin" on public.study_events;
drop policy if exists "study events insert own" on public.study_events;
drop policy if exists "study events delete own" on public.study_events;
drop policy if exists "vocabulary select own or admin" on public.user_vocabulary;
drop policy if exists "vocabulary insert own" on public.user_vocabulary;
drop policy if exists "vocabulary update own" on public.user_vocabulary;
drop policy if exists "vocabulary delete own" on public.user_vocabulary;
drop policy if exists "progress insert own" on public.user_progress;
drop policy if exists "progress update own" on public.user_progress;
drop policy if exists "progress delete own" on public.user_progress;

create policy "study events select own or admin" on public.study_events
for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "study events insert own" on public.study_events
for insert to authenticated with check (user_id = auth.uid());
create policy "study events delete own" on public.study_events
for delete to authenticated using (user_id = auth.uid());

create policy "vocabulary select own or admin" on public.user_vocabulary
for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "vocabulary insert own" on public.user_vocabulary
for insert to authenticated with check (user_id = auth.uid());
create policy "vocabulary update own" on public.user_vocabulary
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "vocabulary delete own" on public.user_vocabulary
for delete to authenticated using (user_id = auth.uid());

create policy "progress insert own" on public.user_progress
for insert to authenticated with check (user_id = auth.uid());
create policy "progress update own" on public.user_progress
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "progress delete own" on public.user_progress
for delete to authenticated using (user_id = auth.uid());

grant select, insert, delete on public.study_events to authenticated;
grant select, insert, update, delete on public.user_vocabulary to authenticated;

-- Existing new-user trigger uses raw_user_meta_data.nickname and creates role='student'.
-- Promote the first administrator after registering their account through the student page:
-- update public.profiles set role = 'admin' where phone = '+8613812345678';
