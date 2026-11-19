-- Tony v1: the pinned Today message, and a memory for photos and files.
-- Safe to run again.

alter table public.settings
  -- The pinned "Today" checklist: which message it is, which day it shows,
  -- and a hash of what it last showed (so it is only edited when it changes).
  add column if not exists today_message_id bigint,
  add column if not exists today_message_day date,
  add column if not exists today_message_hash text,
  -- The media item behind "the last thing he shared", for attaching it to a task.
  add column if not exists last_shared_media_id bigint;

-- Photos, videos, documents and voice notes he has sent, kept so Tony can
-- understand them, find them again, and send the original back.
create table if not exists public.media (
  id              bigint generated always as identity primary key,
  kind            text not null check (kind in ('photo', 'video', 'document', 'voice', 'audio', 'animation')),
  -- Telegram's handle on the original: sending it again costs nothing and loses no quality.
  file_id         text not null,
  file_unique_id  text,
  mime            text,
  caption         text,
  -- What Tony made of it: the text in an image and what it shows, or a voice note's transcript.
  description     text,
  -- What he said it is for ("video idea", "send to the school").
  note            text,
  task_id         bigint references public.tasks (id) on delete set null,
  -- The copy in the private storage bucket, if the file was small enough to copy.
  storage_path    text,
  -- A temporary link to that copy for the app, renewed when it nears expiry.
  signed_url      text,
  signed_until    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists media_task_idx on public.media (task_id);

-- New table: this project grants nothing by default and has row level
-- security on, so the server role is granted access here and nobody else is.
alter table public.media enable row level security;
grant select, insert, update, delete on public.media to service_role;
revoke all on public.media from anon, authenticated;

-- A private bucket for the copies. Not public: files are reachable only by
-- the server, or through a short-lived signed link the server hands out.
insert into storage.buckets (id, name, public, file_size_limit)
values ('tony-media', 'tony-media', false, 20971520)
on conflict (id) do update set public = false;

-- Storage has row level security of its own. Only the server role may read
-- or write this bucket; the public roles get no policy, so they get nothing.
drop policy if exists "tony media: server only" on storage.objects;
create policy "tony media: server only" on storage.objects
  for all to service_role
  using (bucket_id = 'tony-media')
  with check (bucket_id = 'tony-media');
