-- Tony v1: the pinned banner. Telegram's pinned bar shows the start of the
-- pinned message with its lines run together, so the board itself would
-- show task titles there. A one-line status message ("Today · 3/14 done")
-- is pinned instead, right above the board, and kept in step with it.
-- Safe to run again.

alter table public.settings
  add column if not exists today_status_id bigint;
