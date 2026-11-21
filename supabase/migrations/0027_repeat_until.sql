-- A repeating task can end (22 Nov): an 8-week study plan repeats weekly until 17 Jan, not for ever.
-- The last day it may come round, in his local date; null repeats with no end.
alter table public.tasks add column if not exists repeat_until date;
-- tasks already has row level security on and the server role's grants (0001_init.sql); nothing to add.
