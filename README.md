# Tony

A personal AI agent that holds your tasks and keeps reminding you until each
one is started, done, moved or dropped. Telegram to talk, a web app to see.
Spec: [docs/SPEC.md](docs/SPEC.md).

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Setup: site loads, bot answers `/ping` with `pong` | Passed |
| 2 | Tasks core, no AI: text becomes an Inbox task, `/today` and `/inbox` | Passed |
| 3 | Reminder engine: every-minute clock, buttons, persistent mode, quiet hours, caps | Passed |
| 4 | Tony's brain: prompt, seven tools, natural dates | Built, awaiting your check |
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

## Phase 4 check

Tony now reads every message with an AI model and acts through seven tools
(`add_task`, `update_task`, `complete_task`, `list_tasks`, `set_reminder`,
`remember`, `forget`). Button taps and `/today`, `/inbox`, `/ping` still run
plain code.

Setup, once:

1. Create a free API key at console.groq.com (API Keys → Create).
2. In Vercel add it as `AI_API_KEY` and redeploy. The site's **Brain** dot
   turns green and shows the model in use.

**Done when:** "remind me to work out at 6 pm" creates a persistent task at
18:00 and Tony confirms in his voice.

The model is one swappable setting. Any OpenAI-compatible chat API with tool
calling works:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_API_KEY` | none | the provider's key |
| `AI_BASE_URL` | `https://api.groq.com/openai/v1` | the provider |
| `AI_MODEL` | `openai/gpt-oss-120b` | the model |

If the model is unreachable or out of quota, Tony saves the message to the
inbox as written and says so, so nothing you send is lost.

## Reminder engine

A database clock (pg_cron + pg_net) calls `/api/tick` once a minute, with a
retry at :20 and :40 if the call did not land. Its password is generated
inside the database and never leaves it. The site's **Reminder clock** dot is
green while ticks arrive.

Test commands, each creating a task due 2 minutes after you send it:

| Command | Creates |
|---------|---------|
| `/test` | a persistent task that nudges every minute: 4 nudges, then a closing message |
| `/test full` | a persistent task on the real schedule (0, 15, 30, 60, 90, 120 minutes) |
| `/test once` | an ordinary one-time reminder with Done / Snooze / Reschedule |

Rules the engine follows:

- A persistent reminder repeats until Starting now, Skip today or Done is
  tapped. After its last step Tony says he will leave it for today; the task
  stays open and overdue for the morning brief (Phase 7).
- Quiet hours (23:00 to 07:00): no follow-up nudges, unless the task itself
  was set inside that window.
- At most 6 unprompted messages an hour. A first reminder waits for room; a
  follow-up nudge is skipped. Replies to your own messages and taps do not count.
- Button taps run plain code, never the AI model.
- If the site moves to a new address, open `/api/telegram/setup?secret=...`
  again: it tells the clock where to call.

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
