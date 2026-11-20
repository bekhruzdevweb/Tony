-- Tony v1: prayer times by location, from the official table.
-- The Muslim Board's times (namoz-vaqti.uz) for his region are fetched as a
-- table about once a month and stored; each day's prayers are read from it.
-- If the site cannot be read, Aladhan by coordinates is used and marked
-- "(approx.)". The location is a setting (/location). Safe to run again.

create table if not exists public.prayer_times (
  region      text not null,
  day         date not null,
  fajr        text not null,
  dhuhr       text not null,
  asr         text not null,
  maghrib     text not null,
  isha        text not null,
  -- 'official' (namoz-vaqti.uz) or 'approx' (Aladhan by coordinates).
  source      text not null default 'official',
  fetched_at  timestamptz not null default now(),
  primary key (region, day)
);

alter table public.prayer_times enable row level security;
grant select, insert, update, delete on public.prayer_times to service_role;
revoke all on public.prayer_times from anon, authenticated;

alter table public.settings
  -- The region as namoz-vaqti.uz names it in its addresses, and as people say it.
  add column if not exists location_slug text not null default 'xonqa',
  add column if not exists location_name text not null default 'Xonqa tumani, Xorazm viloyati',
  -- For the fallback (Aladhan by coordinates).
  add column if not exists location_lat double precision not null default 41.47,
  add column if not exists location_lng double precision not null default 60.78;
