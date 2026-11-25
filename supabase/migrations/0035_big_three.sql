-- Phase Q (25 Nov): Today's Big 3. "I should be able to choose only 3 important tasks per day":
-- the day a task was chosen as one of that day's three. Null: not chosen.
alter table public.tasks add column if not exists big3_on date;
create index if not exists tasks_big3_on_idx on public.tasks (big3_on) where big3_on is not null;
-- The table's grants (service_role) cover the new column; restated so this file stands on its own.
grant select, insert, update, delete on public.tasks to service_role;
