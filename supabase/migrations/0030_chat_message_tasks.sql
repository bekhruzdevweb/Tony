-- A message about several tasks (a follow-up listing what is still open, a
-- question about one task's time) is removed once every task in it has been
-- settled: done, dropped or moved on, by a button or in his own words
-- (22 Nov: "after i reschedule the task it should be deleted from chat ...
-- otherwise chat is getting worse").
alter table public.chat_messages add column if not exists task_ids bigint[];

-- Table-level grants from 0006 cover the new column; restated so this file
-- stands on its own (automatic API grants are off in this project).
grant select, insert, update, delete on public.chat_messages to service_role;
