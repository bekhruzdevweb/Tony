-- Tony v1: agent mode. Plans he proposes (with his reasons), suggestions he
-- makes unprompted, and what he last asked. Safe to run again.

-- A proposed schedule for a day or a week. Nothing changes until it is applied.
create table if not exists public.plans (
  id          bigint generated always as identity primary key,
  scope       text not null check (scope in ('day', 'week')),
  -- First day covered, as a local date.
  day         date not null,
  -- [{ task_id, title, at, why }]: what goes where, and why there.
  items       jsonb not null default '[]',
  -- [{ task_id, title, why }]: what was left out, and why.
  left_out    jsonb not null default '[]',
  -- Tony's reasoning for the plan as a whole, shown in the app.
  why         text not null default '',
  -- 'model' when the AI proposed the times, 'rules' when the fallback did.
  planned_by  text not null default 'model',
  status      text not null default 'proposed' check (status in ('proposed', 'applied', 'dismissed')),
  message_id  bigint,
  created_at  timestamptz not null default now(),
  applied_at  timestamptz
);

-- New table: this project grants nothing by default and has row level
-- security on, so the server role is granted access here.
alter table public.plans enable row level security;
grant select, insert, update, delete on public.plans to service_role;
revoke all on public.plans from anon, authenticated;

-- A suggestion is one more kind of unprompted message, counted per day.
alter table public.reminders drop constraint if exists reminders_kind_check;
alter table public.reminders add constraint reminders_kind_check
  check (kind in ('due', 'nudge', 'stale', 'brief', 'extra', 'suggest'));

alter table public.settings
  -- A question Tony asked with buttons: { question, options: [..], task_id? }.
  add column if not exists pending_choices jsonb,
  -- A line for the next prompt, when Tony is waiting for an answer in words.
  add column if not exists pending_note text,
  add column if not exists pending_note_at timestamptz;
