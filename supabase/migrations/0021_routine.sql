-- Tony v1: his routine, and how Tony decides when things happen.
--
-- `routine` is one row: his waking day, the hours he keeps for teaching,
-- content, coding and workouts, his free days, and what Tony has learned
-- from the tasks he moved ("content around 10:00"). Every scheduling
-- decision reads it. Windows are plain text Tony parses and shows back,
-- e.g. "Mon-Fri 14:00-18:00" or "10:00-12:00" (every day).
-- Safe to run again.

create table if not exists public.routine (
  id          boolean primary key default true check (id),
  wake        text not null default '07:00',
  sleep       text not null default '23:00',
  teaching    text,
  content     text,
  coding      text,
  workout     text,
  free_days   text,
  -- { "content": [600, 615, 630], ... }: minutes after midnight of his last moves, per kind of task.
  learned     jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- New table: row level security on, the server role granted access, nobody else.
alter table public.routine enable row level security;
grant select, insert, update, delete on public.routine to service_role;
revoke all on public.routine from anon, authenticated;

-- His waking day from his quiet hours; workouts in the evening, as he told Tony
-- ("I work out in the evenings", "work out at 6 pm"). The rest he fills in.
insert into public.routine (id, wake, sleep, workout)
select true, left(coalesce(quiet_end::text, '07:00'), 5), left(coalesce(quiet_start::text, '23:00'), 5), '18:00–20:00' from public.settings limit 1
on conflict (id) do nothing;
insert into public.routine (id) values (true) on conflict (id) do nothing;

-- "Remind me if I don't check it for 2 days": a check-in that comes back every
-- N days while the task sits untouched.
alter table public.reminders add column if not exists every_days integer;

-- A proposed action ("I'll remove Buy notebook") waiting for his ✓ or ✏️.
alter table public.offers drop constraint if exists offers_kind_check;
alter table public.offers add constraint offers_kind_check check (kind in ('task', 'link', 'action'));
