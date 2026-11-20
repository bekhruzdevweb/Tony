-- Tony v1: plans that explain themselves. A plan can carry a lead line
-- ("Today is nearly over, sir — here's tomorrow.") and be a compact
-- proposal for tasks he just gave without times ("Presentation 13:00 ·
-- Zoom tutorial 18:00" with Looks good / Change). Safe to run again.

alter table public.plans
  add column if not exists lead text,
  add column if not exists compact boolean not null default false;
