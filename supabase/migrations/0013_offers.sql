-- Tony v1: offers behind buttons. When Tony suggests turning something into
-- a task ([➕ Make this a task]) or saving a link he summarised ([💾 Save]
-- [➕ Task]), what the button would create is kept here, so the tap is
-- handled in plain code. Safe to run again.

create table if not exists public.offers (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('task', 'link')),
  -- task: { title, due_at? }   link: { url, title, summary }
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  -- When a button acted on it, and what it did ("task", "saved").
  used_at     timestamptz,
  used_as     text
);

-- New table: row level security on, the server role granted access, nobody else.
alter table public.offers enable row level security;
grant select, insert, update, delete on public.offers to service_role;
revoke all on public.offers from anon, authenticated;
