-- Phase R (26 Nov): the guided weekly planning in Telegram ("he asks everything one by one, not all at once").
-- The session in progress: its week, the tasks he chose to leave where they are, and what was done so far.
alter table public.settings add column if not exists week_session jsonb;
-- The table's grants (service_role) cover the new column; restated so this file stands on its own.
grant select, insert, update, delete on public.settings to service_role;
