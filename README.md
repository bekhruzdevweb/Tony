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
| 4 | Tony's brain: prompt, seven tools, natural dates | Passed |
| 5 | Voice notes: download, transcribe, hand to the brain | Passed |
| 6 | The app (PWA): Today, Inbox, Upcoming, Projects, task sheet, Chat, Settings | Passed |
| 7 | Briefs, missed tasks, memory; repeating tasks roll forward | Built, awaiting your check |
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

## Phase 7 check

Every day Tony now sends, at the times set in Settings:

- **Morning brief (08:00):** today's tasks with their times and how many
  were carried over, with an Open app button. Then, for up to two tasks left
  open from an earlier day, one question each with **Today / Tomorrow /
  Drop**. Then, quietly, one inbox item that has been untouched for 3 days,
  with **Tomorrow / This weekend / Drop** (each item at most once in 3 days).
- **Evening review (21:00):** what is still open, with **Move all / Choose /
  Leave them**. Choose lists each task with its own Tomorrow and Drop. If
  nothing is open he says so only when something was completed that day.

A brief that cannot go out on time is still sent for up to 3 hours, then
skipped for that day.

**Repeating tasks** (daily, weekdays, weekly) are never closed: Done or Skip
moves them to their next date with a fresh reminder.

**Done when:** a task left undone yesterday appears in this morning's brief.
To see a brief without waiting, set its time in Settings to a minute or two
ahead, then set it back.

## Opening the app

**Inside Telegram (Mini App).** Tap the **Tony** Menu button beside the
message field, or send `/app` and tap **Open Tony**. There is no key to type:
Telegram signs who opened the app and the server checks that signature
against the bot token on every request. Inside Telegram the app follows
Telegram's colours and uses its Back button and haptics. To put the Menu
button in place after a new deployment, send `/start` to Tony (or open
`/api/telegram/setup?secret=...` once).

**On the home screen (PWA).**

1. Send `/app` to Tony. His reply includes a six-digit key (good once, for
   ten minutes).
2. Open the site in the browser and type the key.
3. Install it: in Safari, Share → Add to Home Screen; in Chrome, menu →
   Install app. The installed app has its own storage, so the first time you
   open it from the home screen it asks for a key again. A sign-in lasts 90
   days.

What is where:

| Screen | Contents |
|--------|----------|
| Today | greeting and date, overdue, today by time, done today, and a quick-add bar that Tony reads ("workout at 6 pm") |
| Inbox | undated tasks, oldest first, with an age badge after 3 days |
| Upcoming | the next 7 days; drag a task by its grip to another day; + adds to that day |
| Chat | the same conversation as Telegram, with a mic |
| + button | a blank task sheet: title, notes, date and time, priority, project, repeat, persistent |
| Avatar (top left) | Projects, and Settings: brief times, quiet hours, persistent schedule, theme, Tony's memory, Telegram link, connection status |

The app re-reads its data every 4 seconds while it is on screen. All times
are Tashkent time. Everything the app changes goes through the same code as
Tony's tools, so the app and Telegram cannot disagree.

## Voice notes

Tony downloads a voice note from Telegram, has it transcribed
(`whisper-large-v3` on Groq, same key as the brain) and handles the text like
a typed message. The language is detected, so Uzbek and Russian notes are
understood; Tony replies in English. Optional settings: `STT_MODEL`,
`STT_BASE_URL`, `STT_API_KEY`.

## In the Telegram chat

**Formatting.** Tony's structured messages use Telegram's HTML: a bold
header with the date, `code` times, project names in italics, 🔔 for
persistent tasks, ⚠️ for overdue ones, and long sections folded into an
expandable quote. Everything you typed is escaped, and if Telegram ever
rejects the markup the same words go out as plain text.

**Checklist.** `/today`, `/tomorrow` and the morning brief are checklists: a
☐ button per task ticks it off in place, ☑ unticks it.

**Polls** (not anonymous, so Tony can read the vote):

- Evening review, when there are two or more candidates: "Which ones
  tomorrow?" over what is still open and the inbox. The picks are scheduled
  for tomorrow and Tony answers with tomorrow's plan as a checklist.
- A task left open from an earlier day: a poll of new times, or Drop it.
- Sunday evening: the week in four numbers and "How did the week go?". The
  answer is kept as a memory note.

**Forwarded posts and photos.** Forward Tony a post, or send a photo, with
or without a caption. He reads the words and the text in the image (a
vision model, `VISION_MODEL`, default `qwen/qwen3.8-27b` on Groq), says in a
line what it is, and offers to make it a task with its date. The item is
remembered for 12 hours as "the last thing you shared", so "schedule this for
tomorrow", typed or spoken, refers to it.

**Native checklists (trial).** Telegram's own checklists can only be sent
through a Telegram Business connection, on behalf of your account, and its
documentation does not say whether a connected bot may post one into its own
chat. `/checklist` tries it and reports Telegram's answer. To connect: in
@BotFather turn on Business Mode for the bot; then Telegram → Settings →
Telegram Business → Chatbots → add the bot, with access limited to selected
chats and none selected for anyone else. Until this is proven, `/today`,
`/tomorrow` and the brief use the button checklist.

**Tidying.** Messages Tony will remove later are recorded in
`chat_messages`; the minute tick deletes what is due.

| Message | Removed |
|---------|---------|
| A reminder's earlier nudges | when the task is done, skipped, snoozed or moved |
| A confirmation ("Noted, sir…"), including a tapped reminder | after 3 hours (24 hours if it answered a voice note) |
| Your `/today`, `/tomorrow`, `/inbox`, `/app` and the reply | when you send the same command again |
| Yesterday's brief, plan, review and polls | when the new one arrives |

Never removed: reminders still waiting for a tap, today's brief and plan,
ordinary conversation, any message you replied to or pinned, and anything
older than 47 hours (Telegram's limit for bots is 48).

**Also:** a button tap writes its outcome into the message you tapped; reply
to a reminder and Tony knows which task you mean; ✍ / 👌 reactions; silent
follow-ups on ordinary P4 tasks; `/help`.

After a deployment that adds a new kind of update (poll votes were one),
send `/start` to Tony once: it refreshes the webhook, the command list and
the Menu button.

**Spoken replies.** Set `TTS_MODEL` (on Groq:
`canopylabs/orpheus-v1-english`, after accepting its terms in the Groq
console) and optionally `TTS_VOICE`. Tony then answers voice notes aloud;
the WAV is converted on the server to OGG/Opus, so Telegram shows a voice
bubble. With `TTS_SPEAK=all` he also speaks the morning brief and, for a
persistent reminder, the third nudge onwards.

His delivery follows the occasion, using Orpheus's bracketed vocal
directions (free-form, one or two words). The direction is added only to
what is sent to the speech model; text messages never contain it.

| When | Direction |
|------|-----------|
| 21:00 to 07:00, whatever the occasion | `[calm]` |
| A persistent reminder's third nudge onwards | `[firmly]` |
| The morning brief; a task just completed | `[cheerful]` |
| Anything else | none (his ordinary voice) |

Orpheus accepts 200 characters per request, so longer text is split at
sentence ends into up to three requests and joined into one voice note.

## Tony's brain

Tony reads every message with an AI model and acts through seven tools
(`add_task`, `update_task`, `complete_task`, `list_tasks`, `set_reminder`,
`remember`, `forget`). Button taps and `/today`, `/inbox`, `/ping` run plain
code. `AI_API_KEY` is a Groq key from console.groq.com.

The model is one swappable setting. Any OpenAI-compatible chat API with tool
calling works:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_API_KEY` | none | the provider's key |
| `AI_BASE_URL` | `https://api.groq.com/openai/v1` | the provider |
| `AI_MODEL` | `openai/gpt-oss-120b` | the model |

| `AI_FALLBACK_MODEL` | `openai/gpt-oss-20b` (on Groq) | used when the main model is rate limited; `none` switches it off |
| `AI_REASONING_EFFORT` | unset | optional `low` / `medium` / `high` for reasoning models |

Free tiers limit tokens per minute (8,000 on Groq for this model), so each
message is kept small: a short prompt, only the tasks and memory notes that
bear on the message, six clipped turns of history, and a confirmation written
in the same call as the action, so most messages cost one model call.

When the provider answers 429, Tony keeps "typing…" showing, waits the time
it names (up to 15 seconds) and tries once more; if that fails he uses the
fallback model, which has its own allowance. Only if all of that fails does
he save the message to the inbox as written and say so. Each call's real
token use and the minute's remaining allowance are written to the Vercel log.

## Reminder engine

A database clock (pg_cron + pg_net) calls `/api/tick` once a minute, with a
retry at :20 and :40 if that minute has no clean tick. A reminder is marked
sent only after Telegram confirms delivery; until then it stays scheduled, so
a stalled or killed tick cannot lose it. Its password is generated
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
