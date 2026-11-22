-- Phase H (22 Nov): habits he chose to build, and tags.
--
-- A habit is now his own choice ("make reading a daily habit"), never any
-- repeating task: a plan's weekly sessions and a monthly bill are not habits
-- ("why ielts is habit???"). Tags are his own words for a theme (#content,
-- #ielts), so "show my content tasks" works across projects.
alter table public.tasks add column if not exists habit boolean not null default false;
alter table public.tasks add column if not exists tags text[] not null default '{}';

-- A titled series gets its name as a tag ("IELTS: Reading + Listening" →
-- ielts, "Workout: Legs A" → workout), as Tony does for new tasks.
update public.tasks
set tags = array[lower(substring(title from '^([A-Za-z][A-Za-z0-9]{1,14}):\s'))]
where tags = '{}' and title ~ '^[A-Za-z][A-Za-z0-9]{1,14}:\s';

create index if not exists tasks_tags_idx on public.tasks using gin (tags);

-- Table-level grants from 0001 cover the new columns; restated so this file
-- stands on its own (automatic API grants are off in this project).
grant select, insert, update, delete on public.tasks to service_role;
