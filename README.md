# Tony

A personal AI agent that holds your tasks and keeps reminding you until each
one is started, done, moved or dropped. Telegram to talk, a web app to see.
Spec: [docs/SPEC.md](docs/SPEC.md).

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Setup: site loads, bot answers `/ping` with `pong` | Passed |
| 2 | Tasks core, no AI: text becomes an Inbox task, `/today` and `/inbox` | Built, awaiting your check |
| 3 | Reminder engine | Not started |
| 4 | Tony's brain | Not started |
| 5 | Voice notes | Not started |
| 6 | The app (PWA) | Not started |
| 7 | Briefs, missed tasks, memory | Not started |
| 8 | Live week | Not started |

## Phase 1 setup (about 10 minutes, all doable on a phone)

1. **Bot.** In Telegram open @BotFather, send `/newbot`, pick a name and a
   username. Keep the token it gives you.
2. **Database.** Create a new project at supabase.com (region near Tashkent,
   e.g. Mumbai or Frankfurt). From Project Settings → API keys, keep the
   project URL and the secret key. Nothing uses them until Phase 2.
3. **Hosting.** In Vercel choose Add New → Project and import the
   `bekhruzdevweb/tony` repository. Leave **Root Directory** empty; the
   production branch is `main`. Add these environment variables:

   | Name | Value |
   |------|-------|
   | `TELEGRAM_BOT_TOKEN` | the token from BotFather |
   | `TELEGRAM_WEBHOOK_SECRET` | a long random string you invent (letters, digits, `_` and `-` only) |
   | `SUPABASE_URL` | the Supabase project URL |
   | `SUPABASE_SECRET_KEY` | the Supabase secret key |

   Deploy.
4. **Connect the bot.** Open
   `https://<your-site>/api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>`
   once. It should answer `"ok": true` with your bot's username.
5. **Lock it to you.** Send `/start` to the bot. Tony replies with your chat
   ID. Add it in Vercel as `TELEGRAM_OWNER_ID` and redeploy.

6. **Give the bot a face (optional).** In @BotFather: `/setuserpic`, choose the
   bot, and send `public/brand/telegram-avatar.png` (also served at
   `https://<your-site>/brand/telegram-avatar.png`).

**Done when:** the site shows three green dots and the bot answers `/ping`
with `pong`.

## Phase 2 check

1. **Create the tables.** In Supabase open SQL Editor, paste the whole of
   [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   and run it. It is safe to run twice.
2. Reload the site: the Database dot should stay green. If it says the tables
   are missing, the migration has not run.
3. Open `https://<your-site>/api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>`
   once more, so `/today` and `/inbox` appear in the bot's command menu.

**Done when:** sending `buy notebook` to the bot shows it in `/inbox`.

## Database rules

The Supabase project has row level security on for new tables and automatic
API grants off. Every migration must therefore add the grants (and any
policies) the server's role needs; a table without them is unreachable.
Migrations live in `supabase/migrations/` and are run by hand in the SQL
Editor, in order.

## Development

```bash
npm install
```

```bash
npm run dev
```

`npm run lint`, `npm run typecheck` and `npm run build` are the checks CI runs.
