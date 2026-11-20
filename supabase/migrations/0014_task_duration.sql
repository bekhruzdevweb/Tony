-- Tony v1: how long a task takes, in minutes, when known. The app's Today
-- view adds up the known ones ("⏱ 2h 30m"); nothing is estimated.
-- Safe to run again.

alter table public.tasks
  add column if not exists duration_minutes integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_duration_minutes_check') then
    alter table public.tasks add constraint tasks_duration_minutes_check check (duration_minutes is null or (duration_minutes > 0 and duration_minutes <= 1440));
  end if;
end $$;
