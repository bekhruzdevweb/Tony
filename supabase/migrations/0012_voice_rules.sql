-- Tony v1: when Tony speaks. /voice on|off|auto, and a count of voice notes
-- sent today (at most three a day in auto, not counting ones he asked for).
-- Safe to run again.

alter table public.settings
  add column if not exists voice_mode text not null default 'auto',
  add column if not exists voice_day date,
  add column if not exists voice_count integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'settings_voice_mode_check') then
    alter table public.settings add constraint settings_voice_mode_check check (voice_mode in ('on', 'off', 'auto'));
  end if;
end $$;
