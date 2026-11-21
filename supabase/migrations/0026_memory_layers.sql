-- Layered memory (22 Nov): this week, this month, always.
-- A note starts in the layer Tony judges right; the Sunday review moves what held
-- up a layer and drops what went stale. Goals are marked so plans put them first.
-- The table and its grants are unchanged; only columns are added.
alter table public.memory add column if not exists layer text not null default 'always';
alter table public.memory add column if not exists goal boolean not null default false;
alter table public.memory add column if not exists confirmed_at timestamptz not null default now();
alter table public.memory add column if not exists mentions integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memory_layer_check') then
    alter table public.memory add constraint memory_layer_check check (layer in ('week', 'month', 'always'));
  end if;
end $$;

-- Existing notes keep their age as their last confirmation.
update public.memory set confirmed_at = created_at where confirmed_at > created_at;
