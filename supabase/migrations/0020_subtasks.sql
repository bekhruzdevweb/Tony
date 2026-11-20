-- Tony v1: subtasks, as in Todoist. A task can have a short checklist of
-- parts ("Post stories" → the app, the speaking club, the grammar series).
-- Safe to run again.

create table if not exists public.subtasks (
  id          bigint generated always as identity primary key,
  task_id     bigint not null references public.tasks (id) on delete cascade,
  title       text not null,
  done        boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists subtasks_task_idx on public.subtasks (task_id, position);

-- New table: row level security on, the server role granted access, nobody else.
alter table public.subtasks enable row level security;
grant select, insert, update, delete on public.subtasks to service_role;
revoke all on public.subtasks from anon, authenticated;
