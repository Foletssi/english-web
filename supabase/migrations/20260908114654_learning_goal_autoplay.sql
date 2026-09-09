-- Eastudy learner goals and autoplay profile MVP.
-- Apply after 20260908_cloud_content_and_admin.sql.

create table if not exists public.learning_targets (
  goal_id text primary key check (goal_id ~ '^[a-z0-9_]{2,40}$'),
  group_name text not null,
  display_name text not null,
  level_label text not null default '',
  focus text not null default '',
  content_status text not null default 'building' check (content_status in ('open', 'building', 'hidden')),
  display_order integer not null default 100,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.learner_goal_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  primary_goal_id text not null references public.learning_targets(goal_id),
  daily_minutes integer not null default 20 check (daily_minutes in (10, 20, 40, 60)),
  self_level text not null default 'unsure' check (self_level in ('beginner', 'elementary', 'intermediate', 'advanced', 'unsure')),
  timezone text not null default 'Asia/Shanghai' check (char_length(timezone) between 1 and 80),
  onboarding_version integer not null default 1 check (onboarding_version > 0),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.user_progress
  add column if not exists watch_coverage_percent numeric(5,2) not null default 0 check (watch_coverage_percent between 0 and 100),
  add column if not exists watch_ranges jsonb not null default '[]'::jsonb check (jsonb_typeof(watch_ranges) = 'array');

create or replace function public.bump_learner_goal_profile_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists learner_goal_profile_revision on public.learner_goal_profiles;
create trigger learner_goal_profile_revision
before update on public.learner_goal_profiles
for each row execute function public.bump_learner_goal_profile_revision();

alter table public.learning_targets enable row level security;
alter table public.learner_goal_profiles enable row level security;

drop policy if exists "learning targets read visible" on public.learning_targets;
drop policy if exists "learning targets admin manage" on public.learning_targets;
drop policy if exists "goal profiles read own" on public.learner_goal_profiles;
drop policy if exists "goal profiles insert own" on public.learner_goal_profiles;
drop policy if exists "goal profiles update own" on public.learner_goal_profiles;
drop policy if exists "goal profiles delete own" on public.learner_goal_profiles;

create policy "learning targets read visible" on public.learning_targets
for select to authenticated using (content_status <> 'hidden' or public.is_admin());
create policy "learning targets admin manage" on public.learning_targets
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "goal profiles read own" on public.learner_goal_profiles
for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "goal profiles insert own" on public.learner_goal_profiles
for insert to authenticated with check (user_id = auth.uid());
create policy "goal profiles update own" on public.learner_goal_profiles
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "goal profiles delete own" on public.learner_goal_profiles
for delete to authenticated using (user_id = auth.uid());

grant select on public.learning_targets to authenticated;
grant select, insert, update, delete on public.learner_goal_profiles to authenticated;

insert into public.learning_targets(goal_id, group_name, display_name, level_label, focus, content_status, display_order)
values
  ('general', '通用能力', '综合英语提升', 'A1–C1', '高频词汇、短语、听力与跟读', 'open', 10),
  ('k12', '升学考试', '中考 / 高考英语', 'K12', '课标词汇、阅读、听说与写作', 'building', 20),
  ('cet4', '大学考试', '大学英语四级 CET-4', 'CET-4', '核心词汇、听力场景与真题表达', 'building', 30),
  ('cet6', '大学考试', '大学英语六级 CET-6', 'CET-6', '进阶词汇、长难句与学术听力', 'building', 40),
  ('postgrad', '升学考试', '考研英语一 / 二', '考研', '大纲词汇、阅读逻辑与写作语料', 'building', 50),
  ('tem', '专业考试', '专四 / 专八 TEM-4/8', 'TEM', '专业词汇、听辨、改错与表达', 'building', 60),
  ('other_cn', '国内考试', '专升本 / PETS / 学位英语', '考试', '分考试词表、语法与题型训练', 'building', 70),
  ('ielts_academic', '留学考试', 'IELTS Academic', 'IELTS', '学术场景词汇与听说读写', 'building', 80),
  ('ielts_general', '留学考试', 'IELTS General', 'IELTS', '生活与工作场景表达', 'building', 90),
  ('toefl', '留学考试', 'TOEFL iBT', 'TOEFL', '校园学术词汇、讲座听力与口语', 'building', 100),
  ('pte_duolingo', '留学考试', 'PTE / Duolingo English Test', 'PTE/DET', '机考题型、高频表达与流利度', 'building', 110),
  ('toeic', '职业考试', 'TOEIC 托业', 'TOEIC', '办公室、商务沟通与职场听力', 'building', 120),
  ('cambridge', '国际体系', '剑桥英语 KET / PET / FCE / CAE', 'CEFR', 'CEFR 分级词汇与综合能力', 'building', 130),
  ('career', '实用英语', '职场 / 商务英语', 'A2–C1', '会议、邮件、面试与跨文化沟通', 'building', 140),
  ('daily', '实用英语', '旅行 / 日常口语', 'A1–B2', '真实 Vlog 场景、短语与跟读', 'open', 150),
  ('custom', '自定义', '自定义学习目标', '自定', '按个人词表和场景组合路线', 'building', 160)
on conflict (goal_id) do update set
  group_name = excluded.group_name,
  display_name = excluded.display_name,
  level_label = excluded.level_label,
  focus = excluded.focus,
  content_status = excluded.content_status,
  display_order = excluded.display_order,
  updated_at = now();

comment on table public.learning_targets is 'Versioned learning-goal catalog; building goals stay selectable but cannot masquerade as finished courses.';
comment on table public.learner_goal_profiles is 'One cross-device primary learning goal per learner.';
