-- Tony v1: proposed tasks. When he gives tasks without times, Tony proposes
-- a time for each; until he taps "Looks good" they are drafts, seen nowhere
-- else. Safe to run again.

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('inbox', 'todo', 'in_progress', 'done', 'skipped', 'dropped', 'draft'));
