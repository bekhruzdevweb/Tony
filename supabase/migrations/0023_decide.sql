-- Tony v1: a day without a time is always asked about; "decide yourself" is his switch.
--
-- routine.auto_kinds: the kinds of task he lets Tony pick a time for himself
-- ("decide yourself for podcasts" → {watch}). Every other day without a time
-- is asked about, with two or three free slots, best first.
-- settings.pending_slot: after he taps [✏️ Other time], the task waiting for
-- the time he types next ({"task_id": 37, "day": "2026-11-23"}), so a plain
-- "20:30" is placed in code with no extra message.
-- Safe to run again.

alter table public.routine  add column if not exists auto_kinds text[] not null default '{}';
alter table public.settings add column if not exists pending_slot jsonb;
alter table public.settings add column if not exists pending_slot_at timestamptz;

-- Both tables keep row level security on; the server role keeps its access, nobody else.
alter table public.routine  enable row level security;
alter table public.settings enable row level security;
grant select, insert, update, delete on public.routine, public.settings to service_role;
revoke all on public.routine, public.settings from anon, authenticated;
