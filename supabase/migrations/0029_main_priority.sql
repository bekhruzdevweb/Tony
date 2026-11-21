-- His main priority (22 Nov, his idea): the one thing he must finish, chased until it is done.
-- One thing at a time: setting one clears the last (it may span the sessions of one plan, one a day).
alter table public.tasks add column if not exists main_priority boolean not null default false;
-- tasks already has row level security on and the server role's grants (0001_init.sql); nothing to add.
