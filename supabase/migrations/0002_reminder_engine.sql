-- Tony v1, phase 3: the reminder engine.
--
-- Adds what the engine needs to the existing tables and starts a clock that
-- calls Tony's server once a minute. Safe to run again.
--
-- No new tables, so no new grants: the server role's table grants from
-- 0001 cover the added columns.

-- Per-task override of the persistent schedule (minutes after the due time).
alter table public.tasks
  add column if not exists persistent_schedule integer[];

-- When a reminder actually went out; the hourly message cap counts on this.
alter table public.reminders
  add column if not exists sent_at timestamptz;

create index if not exists reminders_sent_at_idx on public.reminders (sent_at) where sent_at is not null;
create index if not exists reminders_task_idx on public.reminders (task_id);

-- Where the server lives, the password the clock presents to it, and when
-- the clock last got through. The password is generated here, inside the
-- database, so it never passes through anyone's hands; only the server role
-- can read this table.
alter table public.settings
  add column if not exists app_url text,
  add column if not exists tick_secret text not null
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  add column if not exists last_tick_at timestamptz;

-- The clock: pg_cron fires every minute, pg_net makes the HTTPS call.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'tony-tick';

select cron.schedule(
  'tony-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url := rtrim(s.app_url, '/') || '/api/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || s.tick_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  )
  from public.settings s
  where s.app_url is not null
  $job$
);
