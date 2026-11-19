-- Tony v1: reminders that cannot be lost, and what the app's sign-in needs.
-- Safe to run again. No new tables, so no new grants.

-- A reminder used to be marked 'sent' before Telegram had answered; when the
-- call to Telegram stalled, the reminder was lost. Now a tick takes a short
-- lease on a reminder while it sends, and marks it 'sent' only once Telegram
-- has confirmed delivery. A lease left behind by a tick that died expires,
-- and the next tick sends the reminder.
alter table public.reminders
  add column if not exists claimed_at timestamptz;

-- Sign-in for the app: Tony hands the owner a one-time link in Telegram.
-- session_secret signs the app's cookie; it is generated here, inside the
-- database, and only the server role can read this table.
alter table public.settings
  add column if not exists session_secret text not null
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  add column if not exists login_token_hash text,
  add column if not exists login_token_expires_at timestamptz;
