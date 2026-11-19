-- Tony v1, phase 4: what the brain's tools need.
-- Safe to run again. No new tables, so no new grants.

-- set_reminder creates an extra, one-off reminder for a task. It is asked
-- for by the user, so it is not a follow-up nudge and needs its own kind.
alter table public.reminders drop constraint if exists reminders_kind_check;
alter table public.reminders add constraint reminders_kind_check
  check (kind in ('due', 'nudge', 'stale', 'brief', 'extra'));

-- The starting projects named in the spec. Rename or recolour freely.
insert into public.projects (name, color, sort_order) values
  ('Teaching', '#5B8BFF', 1),
  ('Content',  '#7A5CFF', 2),
  ('Health',   '#34C759', 3),
  ('Personal', '#FF9F0A', 4)
on conflict (name) do nothing;
