-- Tony v1: keeping the Telegram chat tidy.
--
-- Every message Tony may later remove is recorded here with its kind and,
-- once it is known, the time after which it can go. The minute tick deletes
-- what is due. Safe to run again.

create table if not exists public.chat_messages (
  id            bigint generated always as identity primary key,
  message_id    bigint not null unique,
  -- 'reminder', 'prompt', 'stale', 'brief:morning', 'brief:evening',
  -- 'confirmation', 'cmd:today', 'cmd:inbox', 'cmd:app', 'voice'
  kind          text not null,
  task_id       bigint references public.tasks (id) on delete set null,
  -- True for the user's own message (a command he typed), false for Tony's.
  incoming      boolean not null default false,
  -- Never removed: he pinned it or replied to it.
  protected     boolean not null default false,
  created_at    timestamptz not null default now(),
  -- Null means "keep". Set when the message has served its purpose.
  delete_after  timestamptz,
  deleted_at    timestamptz
);

create index if not exists chat_messages_due_idx on public.chat_messages (delete_after)
  where deleted_at is null and delete_after is not null;
create index if not exists chat_messages_task_idx on public.chat_messages (task_id);

-- This project grants nothing by default and has row level security on for
-- new tables: only Tony's server may touch this one.
alter table public.chat_messages enable row level security;
grant select, insert, update, delete on public.chat_messages to service_role;
revoke all on public.chat_messages from anon, authenticated;

-- Polls Tony has sent, so a vote can be turned back into an action: each
-- option remembers what choosing it means.
create table if not exists public.polls (
  poll_id     text primary key,
  message_id  bigint not null,
  -- 'plan' (which tasks tomorrow), 'missed' (new time for one task), 'week' (weekly review)
  kind        text not null,
  task_id     bigint references public.tasks (id) on delete set null,
  options     jsonb not null,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

alter table public.polls enable row level security;
grant select, insert, update, delete on public.polls to service_role;
revoke all on public.polls from anon, authenticated;

-- A plan message (tomorrow's checklist) is one more kind of tracked message;
-- kinds are free text, so nothing to change in chat_messages.
