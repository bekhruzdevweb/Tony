-- Tony v1: the coach. A log of each repeating task's completions (for
-- streaks), a record of what the coach has already said (so nudges stay
-- within their daily limit), and a count of characters spoken by
-- ElevenLabs this month. Safe to run again.

-- One row per occurrence of a repeating task that was done or skipped.
-- "day" is the local date the occurrence was due, not when it was ticked.
create table if not exists public.habit_log (
  id       bigint generated always as identity primary key,
  task_id  bigint not null references public.tasks (id) on delete cascade,
  day      date not null,
  outcome  text not null check (outcome in ('done', 'skipped')),
  at       timestamptz not null default now(),
  unique (task_id, day)
);
create index if not exists habit_log_task_day_idx on public.habit_log (task_id, day desc);

-- What the coach has sent: one row per kind, habit and day, so the same
-- nudge is never sent twice and the daily cap can be counted.
create table if not exists public.coach_events (
  id       bigint generated always as identity primary key,
  kind     text not null,
  task_id  bigint references public.tasks (id) on delete cascade,
  day      date not null,
  at       timestamptz not null default now(),
  unique nulls not distinct (kind, task_id, day)
);
create index if not exists coach_events_day_idx on public.coach_events (day);

-- New tables: row level security on, the server role granted access, and
-- nobody else (this project grants nothing by default).
alter table public.habit_log enable row level security;
alter table public.coach_events enable row level security;
grant select, insert, update, delete on public.habit_log to service_role;
grant select, insert, update, delete on public.coach_events to service_role;
revoke all on public.habit_log from anon, authenticated;
revoke all on public.coach_events from anon, authenticated;

alter table public.settings
  -- Streaks are counted from this day on; nothing before it is called a miss.
  add column if not exists habits_since date not null default ((now() at time zone 'Asia/Tashkent')::date),
  -- Characters sent to ElevenLabs in the month named here (YYYY-MM).
  add column if not exists tts_month text,
  add column if not exists tts_chars integer not null default 0;

-- What is already known: each repeating task's last completion.
insert into public.habit_log (task_id, day, outcome, at)
select id, (completed_at at time zone 'Asia/Tashkent')::date, 'done', completed_at
from public.tasks
where repeat_rule is not null and completed_at is not null
on conflict (task_id, day) do nothing;
