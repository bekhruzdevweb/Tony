-- One scheduled reminder per task (22 Nov): two writes at once had made two reminders for task 52,
-- both at 17:45. The newest of any such pair is kept, the rest are cancelled, and an index stops it
-- happening again (scheduleReminder moves the one there is instead).
update public.reminders set state = 'cancelled'
where id in (
  select id from (
    select id, row_number() over (partition by task_id order by id desc) as n
    from public.reminders
    where state = 'scheduled' and kind = 'due'
  ) ranked
  where n > 1
);
create unique index if not exists reminders_one_due_per_task on public.reminders (task_id) where state = 'scheduled' and kind = 'due';
