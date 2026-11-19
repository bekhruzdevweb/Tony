-- Tony v1, phase 3 follow-up: survive a missed clock call.
--
-- pg_net occasionally fails a request ("Error in the HTTP2 framing layer")
-- and offers no way to force HTTP/1.1. So a second job watches each minute:
-- 20 and 40 seconds in, if the server has not recorded a tick for this
-- minute, it calls again. A lost call now costs 20 seconds, not a minute.
--
-- The server already sends anything overdue on every tick, and claims each
-- reminder before sending it, so an extra call can never send twice.
-- Safe to run again.

-- A procedure, not a function: it commits after queuing each retry, which is
-- what releases the request to pg_net. (For the same reason it has no SET
-- clause; every name below is schema-qualified instead.)
create or replace procedure public.tony_tick_retry()
language plpgsql
security invoker
as $$
begin
  for attempt in 1..2 loop
    perform pg_catalog.pg_sleep(20);
    perform net.http_post(
      url := pg_catalog.rtrim(s.app_url, '/') || '/api/tick',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || s.tick_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 15000
    )
    from public.settings s
    where s.app_url is not null
      and (s.last_tick_at is null
           or s.last_tick_at < pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp()));
    commit;
  end loop;
end;
$$;

-- Only the database's own scheduler runs this.
revoke all on procedure public.tony_tick_retry() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'tony-tick-retry';
select cron.schedule('tony-tick-retry', '* * * * *', 'call public.tony_tick_retry()');
