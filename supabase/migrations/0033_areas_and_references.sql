-- Phase O (25 Nov): his life areas, and references.
-- Areas are his projects, named as he thinks of them ("content creation, personal development, business"),
-- with IELTS and Business added. Prayer keeps its name: the prayer code looks it up.
update public.projects set name = 'Content creation' where name = 'Content' and not exists (select 1 from public.projects where name = 'Content creation');
update public.projects set name = 'Personal development' where name = 'Personal' and not exists (select 1 from public.projects where name = 'Personal development');
insert into public.projects (name, color, sort_order) values ('IELTS', '#FF375F', 6), ('Business', '#0A84FF', 7) on conflict (name) do nothing;

-- A reference: something he saved to work from later ("make a reel cover like this"). It is not a task and
-- has no reminder; Tony offers it when he starts a task that is really about the same thing. It sits in an area.
alter table public.media add column if not exists reference boolean not null default false;
alter table public.media add column if not exists project_id bigint references public.projects (id) on delete set null;
alter table public.library add column if not exists reference boolean not null default false;
alter table public.library add column if not exists project_id bigint references public.projects (id) on delete set null;
-- The tables' grants (service_role) cover the new columns; row level security stays on with no new policies.

-- His open IELTS tasks, tagged as such, go to the new area.
update public.tasks set project_id = (select id from public.projects where name = 'IELTS')
where project_id is null and status in ('inbox', 'todo', 'in_progress') and (tags @> array['ielts'] or title ilike '%ielts%');
