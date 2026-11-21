-- Round videos (Telegram video notes) are kept like any other file (21 Nov audit).
-- The table and its grants are unchanged; only the allowed kinds grow by one.
alter table public.media drop constraint if exists media_kind_check;
alter table public.media add constraint media_kind_check
  check (kind = any (array['photo', 'video', 'document', 'voice', 'audio', 'animation', 'video_note']));
