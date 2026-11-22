-- Phase J (23 Nov): a task for a day with no time ("clean my room": "it doesn't even take 5 minutes, so I
-- should not be having any timeline"). Its due_at is that day at 20:00, when one quiet check comes;
-- everywhere else it shows as "anytime" and takes no time from the day.
alter table public.tasks add column if not exists anytime boolean not null default false;
-- The table's grants (service_role) cover the new column; no policy changes.
