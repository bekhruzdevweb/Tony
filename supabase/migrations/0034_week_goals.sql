-- Phase P (25 Nov): the weekly planner. The three to five outcomes he chooses for a week
-- ("choose three to five meaningful outcomes for the upcoming week"), each optionally in a life area.
create table if not exists public.week_goals (
  id          bigint generated always as identity primary key,
  week_start  date not null,
  title       text not null check (length(btrim(title)) > 0),
  done        boolean not null default false,
  project_id  bigint references public.projects (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists week_goals_week_idx on public.week_goals (week_start);
-- Only the server reads and writes it: row level security on with no policies, and the grant it needs.
alter table public.week_goals enable row level security;
grant select, insert, update, delete on public.week_goals to service_role;
