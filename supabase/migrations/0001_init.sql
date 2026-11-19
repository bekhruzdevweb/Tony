-- Tony v1: the six tables from the spec.
--
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- This project has row level security on for new tables and automatic API
-- grants off, so nothing can reach a table until it is granted here. Only
-- Tony's server (the secret key, role service_role) gets access; the public
-- roles (anon, authenticated) get none, and no policies are defined for them.

create table if not exists public.projects (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  color       text not null default '#5B8BFF',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.tasks (
  id            bigint generated always as identity primary key,
  title         text not null check (length(btrim(title)) > 0),
  notes         text,
  project_id    bigint references public.projects (id) on delete set null,
  priority      smallint not null default 4 check (priority between 1 and 4),
  status        text not null default 'inbox'
                check (status in ('inbox', 'todo', 'in_progress', 'done', 'skipped', 'dropped')),
  due_at        timestamptz,
  repeat_rule   text check (repeat_rule in ('daily', 'weekdays', 'weekly')),
  persistent    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists tasks_status_due_idx on public.tasks (status, due_at);

create table if not exists public.reminders (
  id                   bigint generated always as identity primary key,
  task_id              bigint references public.tasks (id) on delete cascade,
  fire_at              timestamptz not null,
  kind                 text not null check (kind in ('due', 'nudge', 'stale', 'brief')),
  attempt              integer not null default 0,
  state                text not null default 'scheduled'
                       check (state in ('scheduled', 'sent', 'acknowledged', 'cancelled')),
  telegram_message_id  bigint,
  created_at           timestamptz not null default now()
);

create index if not exists reminders_due_idx on public.reminders (fire_at) where state = 'scheduled';

create table if not exists public.memory (
  id          bigint generated always as identity primary key,
  fact        text not null,
  source      text not null default 'user',
  created_at  timestamptz not null default now()
);

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  role        text not null check (role in ('user', 'tony')),
  text        text not null,
  channel     text not null check (channel in ('telegram', 'app')),
  created_at  timestamptz not null default now()
);

-- One row only: Tony has a single user.
create table if not exists public.settings (
  id                   boolean primary key default true check (id),
  telegram_chat_id     bigint,
  timezone             text not null default 'Asia/Tashkent',
  brief_morning        time not null default '08:00',
  brief_evening        time not null default '21:00',
  quiet_start          time not null default '23:00',
  quiet_end            time not null default '07:00',
  persistent_schedule  integer[] not null default '{0,15,30,60,90,120}'
);

insert into public.settings (id) values (true) on conflict (id) do nothing;

-- Keep tasks.updated_at honest without relying on every caller.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- Row level security: on everywhere, with no policies, so the public roles
-- see nothing even if a grant is added by mistake later.
alter table public.projects  enable row level security;
alter table public.tasks     enable row level security;
alter table public.reminders enable row level security;
alter table public.memory    enable row level security;
alter table public.messages  enable row level security;
alter table public.settings  enable row level security;

-- Grants: the server role only.
grant usage on schema public to service_role;
grant select, insert, update, delete on
  public.projects, public.tasks, public.reminders,
  public.memory, public.messages, public.settings
  to service_role;
revoke all on
  public.projects, public.tasks, public.reminders,
  public.memory, public.messages, public.settings
  from anon, authenticated;
