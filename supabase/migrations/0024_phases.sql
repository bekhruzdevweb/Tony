-- Tony v1: smart context, Free Time, follow-ups, safety (phases b–e, 21 Nov).
-- Safe to run again.

-- ── b) Burst rule: messages that arrive within a minute are one request ──
-- Each message waits here a few seconds; the last one of a burst takes them all.
create table if not exists public.incoming (
  id           bigint generated always as identity primary key,
  chat_id      bigint not null,
  update_id    bigint not null unique,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  claimed_at   timestamptz
);
create index if not exists incoming_open on public.incoming (chat_id, received_at) where claimed_at is null;

-- ── b) Library: every link and forwarded post he sends, with what it is ──
-- (Photos, videos, files and voice notes are already kept in media.)
create table if not exists public.library (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('link', 'post')),
  url          text,
  title        text,
  description  text,
  source       text,
  task_id      bigint references public.tasks (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists library_recent on public.library (created_at desc);

-- Links he saved with 💾 were kept in memory ("Saved link: <title> (<url>)"): they move to the library.
insert into public.library (kind, url, title, source, created_at)
select 'link',
       substring(fact from '\((https?://[^)\s]+)\)\s*\.?$'),
       nullif(trim(substring(fact from '^Saved link:\s*(.*?)\s*\(https?://')), ''),
       'saved',
       created_at
from public.memory
where fact like 'Saved link:%'
  and substring(fact from '\((https?://[^)\s]+)\)\s*\.?$') is not null
  and not exists (select 1 from public.library l where l.url = substring(fact from '\((https?://[^)\s]+)\)\s*\.?$'));
delete from public.memory
where fact like 'Saved link:%'
  and exists (select 1 from public.library l where l.url = substring(fact from '\((https?://[^)\s]+)\)\s*\.?$'));

-- ── b) Situation rules: "when I'm not motivated to work out, send me this video" ──
create table if not exists public.rules (
  id             bigint generated always as identity primary key,
  situation      text not null,
  action         text not null,
  media_id       bigint references public.media (id) on delete set null,
  library_id     bigint references public.library (id) on delete set null,
  -- Proactive: when he has not done this kind of task for this many days.
  skip_kind      text,
  skip_days      integer,
  active         boolean not null default true,
  last_fired_at  timestamptz,
  created_at     timestamptz not null default now()
);

-- ── c) Free Time list: "in my free time", "someday" ──
alter table public.tasks add column if not exists free_time boolean not null default false;

-- ── e) Daily backup of tasks, memory and the library (the last 14 are kept) ──
create table if not exists public.backups (
  id          bigint generated always as identity primary key,
  day         text not null unique,
  tasks       jsonb not null,
  memory      jsonb not null,
  library     jsonb not null,
  created_at  timestamptz not null default now()
);

-- ── e) Mistakes he marks with 👎, each to become a regression test ──
create table if not exists public.mistakes (
  id                   bigint generated always as identity primary key,
  telegram_message_id  bigint,
  tony_text            text,
  his_text             text,
  context              jsonb not null default '[]'::jsonb,
  note                 text,
  created_at           timestamptz not null default now()
);

-- ── e) Which Telegram message each of Tony's replies became, so 👎 finds its text ──
alter table public.messages add column if not exists telegram_message_id bigint;
create index if not exists messages_telegram on public.messages (telegram_message_id) where telegram_message_id is not null;

-- New tables: row level security on, the server role granted access, nobody else.
alter table public.incoming enable row level security;
alter table public.library  enable row level security;
alter table public.rules    enable row level security;
alter table public.backups  enable row level security;
alter table public.mistakes enable row level security;
grant select, insert, update, delete on public.incoming, public.library, public.rules, public.backups, public.mistakes to service_role;
revoke all on public.incoming, public.library, public.rules, public.backups, public.mistakes from anon, authenticated;
-- Columns added to existing tables keep those tables' grants.
grant select, insert, update, delete on public.tasks, public.messages to service_role;
