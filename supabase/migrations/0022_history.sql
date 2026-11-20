-- Tony v1: a change history for every task, /undo, and an event log.
--
-- task_history: the database itself records each change to a task (the
-- whole row before and after), whichever path made it: Tony, a button, the
-- app or the clock. /undo shows the last ten and puts one back. Prayer
-- times (made and replaced every day) and unconfirmed drafts are not
-- recorded, nor saves that changed nothing but the timestamp.
--
-- events: things worth knowing later, starting with the model failing to
-- answer ("I didn't catch that, sir.").
-- Safe to run again.

create table if not exists public.task_history (
  id          bigint generated always as identity primary key,
  task_id     bigint not null,
  action      text not null check (action in ('insert', 'update', 'delete')),
  before      jsonb,
  after       jsonb,
  -- When /undo put this change back.
  undone_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists task_history_recent on public.task_history (created_at desc);
create index if not exists task_history_task on public.task_history (task_id, created_at desc);

create or replace function public.record_task_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.kind = 'prayer' or new.status = 'draft' then return null; end if;
    insert into public.task_history (task_id, action, after) values (new.id, 'insert', to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    if new.kind = 'prayer' or (old.status = 'draft' and new.status = 'draft') then return null; end if;
    if (to_jsonb(old) - 'updated_at') = (to_jsonb(new) - 'updated_at') then return null; end if;
    insert into public.task_history (task_id, action, before, after) values (new.id, 'update', to_jsonb(old), to_jsonb(new));
  elsif tg_op = 'DELETE' then
    if old.kind = 'prayer' or old.status = 'draft' then return null; end if;
    insert into public.task_history (task_id, action, before) values (old.id, 'delete', to_jsonb(old));
  end if;
  return null;
end;
$$;

drop trigger if exists tasks_history on public.tasks;
create trigger tasks_history
  after insert or update or delete on public.tasks
  for each row execute function public.record_task_history();

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  kind        text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_recent on public.events (kind, created_at desc);

-- New tables: row level security on, the server role granted access, nobody else.
alter table public.task_history enable row level security;
alter table public.events enable row level security;
grant select, insert, update, delete on public.task_history to service_role;
grant select, insert, update, delete on public.events to service_role;
revoke all on public.task_history from anon, authenticated;
revoke all on public.events from anon, authenticated;
-- Only the trigger runs it.
revoke execute on function public.record_task_history() from public, anon, authenticated;
