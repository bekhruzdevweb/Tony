-- Tony v1: the last thing he shared, and an optional Telegram Business link.
-- Safe to run again. No new tables, so no new grants.

alter table public.settings
  -- The last forwarded post or photo, so "schedule this for tomorrow" has
  -- something to refer to.
  add column if not exists last_shared_text text,
  add column if not exists last_shared_at timestamptz,
  -- Set when he connects Tony under Telegram Business (needed only for
  -- native checklists); cleared when he disconnects.
  add column if not exists business_connection_id text;
