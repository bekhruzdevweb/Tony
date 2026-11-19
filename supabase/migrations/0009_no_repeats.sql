-- Tony v1: no repeated replies, and the end of the Telegram Business trial.
-- Safe to run again.

-- Every Telegram update Tony has handled. Telegram can deliver the same
-- update more than once; the second arrival is recognised here and ignored.
create table if not exists public.updates_seen (
  update_id  bigint primary key,
  seen_at    timestamptz not null default now()
);

-- New table: this project grants nothing by default and has row level
-- security on, so the server role is granted access here.
alter table public.updates_seen enable row level security;
grant select, insert, update, delete on public.updates_seen to service_role;
revoke all on public.updates_seen from anon, authenticated;

alter table public.settings
  -- The last text Tony sent (as a hash), so the same message is not sent twice running.
  add column if not exists last_sent_hash text,
  add column if not exists last_sent_at timestamptz,
  add column if not exists last_sent_id bigint,
  -- Native checklists turned out to be impossible in Tony's own chat.
  drop column if exists business_connection_id;
