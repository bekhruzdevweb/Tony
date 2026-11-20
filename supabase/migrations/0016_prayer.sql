-- Tony v1: prayer times. Each day the five times for Tashkent are fetched
-- (Aladhan) and added as calm reminders in a "Prayer" project.
-- Safe to run again.

-- What sort of task this is: null for ordinary tasks, 'prayer' for the
-- five daily prayers (kept out of counts, overdue lists, nudges and plans).
alter table public.tasks
  add column if not exists kind text;

alter table public.settings
  -- /prayer on|off
  add column if not exists prayer_on boolean not null default true,
  -- Aladhan's calculation method (3 = Muslim World League) and Asr school (0 = standard, 1 = Hanafi).
  add column if not exists prayer_method integer not null default 3,
  add column if not exists prayer_school integer not null default 1,
  -- The local day the times were last fetched for.
  add column if not exists prayer_day date;

insert into public.projects (name, color, sort_order)
select 'Prayer', '#2FA39A', coalesce((select max(sort_order) from public.projects), 0) + 1
where not exists (select 1 from public.projects where name = 'Prayer');
