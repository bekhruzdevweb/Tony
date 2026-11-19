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
(`whisper-large-v3` on Groq, `GROQ_API_KEY`) and handles the text like
a typed message. The language is detected, so Uzbek and Russian notes are
understood; Tony replies in English. Optional settings: `STT_MODEL`,
`STT_BASE_URL`, `STT_API_KEY`.

## Agent mode

Tony proposes instead of waiting to be told.

**Planner.** "Plan my day", "plan the week", "schedule them yourself",
`/plan`, `/plan week`, the **Plan tomorrow for me** button on the evening
review, or **Plans** in the app. Tony takes what is waiting (overdue tasks
and the inbox), what is already fixed on those days, and what he knows about
your habits, and proposes a time for each task with a reason.

- The AI model proposes; code decides. Every proposed time is checked against
  the day (08:00 until an hour before quiet hours), the current time and the
  fixed events, and moved to the nearest free hour if it clashes. Things are
  kept an hour apart, with at most five new tasks a day.
- If the model is unavailable, a rule-based planner fills the slots: habits
  from memory first ("Works out in the evenings" puts Workout at 18:00), then
  the first free hour. The plan says which of the two made it.
- A plan changes nothing until you tap **Apply**. **Adjust** gives each task
  −1h / +1h / ✕, plus Plan again and Drop plan.
- Each plan is stored with its overall reason and one per task; the app shows
  them under the avatar → **Plans**.

**Suggestions.** Every quarter of an hour Tony looks for an overdue task
whose own reminders have finished (or, once a day, an inbox item when the
next hour and a half is free) and proposes one concrete slot, with buttons:
Yes / Tomorrow / Drop it / Other. At most three a day, never two within two
hours, never in quiet hours, and within the hourly message cap.

**Buttons instead of open questions.** When Tony must ask and the answers
can be guessed, he asks with two to four buttons and an Other button. A tap
is fed back to him as your answer; Other lets you answer in words.

**Self-knowledge.** His prompt carries one block of what he can always do
(hear voice notes and answer aloud, read forwarded posts and photos, set
reminders, plan, brief, remember) with the instruction never to deny it.

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

**The pinned Today message.** One message, pinned silently. The text is
the whole day, left-aligned, time first:

    📋 Today · Fri 20 Nov   1/3

    ☐ ⚠️ Wed 23:29 Reply to the school
    ☐ 18:00 English Speaking Club
    ☑ 09:00 Morning walk            (struck through)

Carried-over tasks (⚠️) come first, then today's in time order, then the
done ones, struck through, at the bottom. Below it, a short button per task
(about 18 characters, two to a row: "☐ Speaking Club") and a last row with
➕ Add and 📱 App. Button labels are the title cut down to its core ("Attend
English Speaking Club – More Than a Game" → "Speaking Club"); the full title
is in the text. A tap ticks a task off or unticks it in plain code, and the
same message is edited in place. It also redraws itself after every message,
tap, reminder tick and change made in the app, but only talks to Telegram
when something changed. A fresh one arrives with the morning brief;
`/today` (also `/checklist` and `/list`) sends a new one and pins it. Either
way the previous board is unpinned and deleted, so there is only ever one.
Its message id lives in settings.

**Media memory.** Every photo, video, document, GIF and voice note you send
is saved: Telegram's file id (so the original can be sent back untouched),
your caption, a copy in the private storage bucket `tony-media`, and what
Tony made of it (the text in an image and what it shows; a voice note's
transcript). Say "remind me about this tomorrow" and the task is linked to
it: the reminder is the original photo with your note and the usual buttons.
"Save this as a video idea" files it under a label; "show my video ideas"
sends the matching originals back. In the app a task with an attachment has
a 📎 and shows the picture in its sheet, through a link that lasts a day.

Both need migration `0010_board_and_media.sql` (applied). Without it the
code falls back: `/today` sends the old checklist and media is read but not
saved.

**Forwarded posts and photos.** Forward Tony a post, or send a photo, with
or without a caption. He reads the words and the text in the image (Claude reads
it; if Claude cannot, the Groq model in `VISION_MODEL` does), says in a
line what it is, and offers to make it a task with its date. The item is
remembered for 12 hours as "the last thing you shared", so "schedule this for
tomorrow", typed or spoken, refers to it.

**No repeats.** Telegram can deliver one update several times; each update
id is recorded and a second arrival is ignored. Separately, the same text
with the same buttons is never sent twice within five minutes: the second
send is skipped and the first message stands. A mistyped command gets the
closest real one suggested ("/tody" → "Did you mean /today?").

Native Telegram checklists are not used: a bot can only send them through a
Business connection into the owner's chats with other people, not into its
own chat (Telegram answers `BUSINESS_PEER_INVALID`). The ☐/☑ buttons are the
checklist.

**Tidying.** Messages Tony will remove later are recorded in
`chat_messages`; the minute tick deletes what is due.

| Message | Removed |
|---------|---------|
| Your commands (`/today`, `/help`, `/inbox`...) | as soon as Tony has handled them |
| An apology, "I don't know that command", "my thinking is briefly unavailable", and your message that caused it | after 10 minutes (your voice notes are kept) |
| `pong` | after 10 minutes |
| `/help`, `/inbox`, `/app` replies | when you send the same command again |
| The previous Today board | when a new one is sent |
| A reminder's earlier nudges | when the task is done, skipped, snoozed or moved |
| A confirmation ("Noted, sir…"), including a tapped reminder | after 3 hours (24 hours if it answered a voice note) |
| The morning brief | at the evening review |
| Yesterday's plan, review and polls | when the new one arrives |

**`/clean`** sweeps the whole recent chat in plain code (no AI). Telegram
numbers a private chat's messages one after another, so Tony walks back
from the newest number about 500 messages (stopping at 47 hours, the limit
for a bot) and deletes them with `deleteMessages`, 100 at a time; numbers
already gone are skipped. It keeps the pinned Today board (and anything
else pinned), reminders still waiting for a tap, and the latest morning
brief; everything else, yours and Tony's, goes. Then "Chat cleaned, sir."
appears and removes itself after 10 seconds. The same sweep runs once by
itself on the first tick after a deployment that changes `SWEEP_ONCE_ID`
in `src/lib/sweep.ts`.

Outside `/clean`, never removed: the pinned board, reminders still waiting for a tap, your
voice notes, the morning brief before evening, ordinary conversation, any
message you replied to or pinned, and anything older than 47 hours
(Telegram's limit for bots is 48).

**Also:** a button tap writes its outcome into the message you tapped; reply
to a reminder and Tony knows which task you mean; ✍ / 👌 reactions; silent
follow-ups on ordinary P4 tasks; `/help`.

After a deployment that adds a new kind of update (poll votes were one),
send `/start` to Tony once: it refreshes the webhook, the command list and
the Menu button.

**Spoken replies.** Tony speaks on two occasions: in answer to a voice
note, and for the morning brief. What he says aloud is short (whole
sentences, up to about 300 characters); the full reply is in the text
message beside it.

His voice is ElevenLabs (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, model
`eleven_flash_v2_5`). The audio is asked for as Opus and sent to Telegram as
it is when it arrives in an Ogg stream; if it does not, the same words are
asked for as plain samples and encoded to OGG/Opus on the server, so
Telegram always shows a voice bubble.

If ElevenLabs fails for any reason (an outage, a rejected key, credits run
out), Orpheus on Groq speaks instead (`TTS_MODEL`, default
`canopylabs/orpheus-v1-english`, after accepting its terms in the Groq
console; `TTS_VOICE`, default `daniel`; `TTS_MODEL=none` switches the
fallback off). Orpheus takes bracketed vocal directions, added only to what
is sent to it: `[calm]` from 21:00 to 07:00, `[cheerful]` for the morning
brief and a task just completed. ElevenLabs is never sent one, and anything
in square brackets is removed from the words before they go to it.

## Tony's brain

Tony reads every message with an AI model and acts through seven tools
(`add_task`, `update_task`, `complete_task`, `list_tasks`, `set_reminder`,
`remember`, `forget`). Button taps and `/today`, `/inbox`, `/ping` run plain
code and never reach a model.

The brain is Claude (`claude-haiku-5-5`) through the Anthropic API, using
the official SDK. Groq is kept for his hearing (Whisper), as the fallback voice
(Orpheus) and as the fallback: if a call to Claude fails for any reason (rate
limit, outage, a rejected key, a declined request), the same request goes to
`openai/gpt-oss-120b` on Groq, so the message is still handled. Photos are
read by Claude too, with a Groq vision model behind it.

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | none | Claude, the main brain |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | the Claude model |
| `ANTHROPIC_EFFORT` | `low` | how hard he thinks before answering (`low`, `medium`, `high`) |
| `GROQ_API_KEY` | none | voice and the fallback brain (the older name `AI_API_KEY` still works) |
| `AI_MODEL` | `openai/gpt-oss-120b` | the fallback brain on Groq |
| `AI_FALLBACK_MODEL` | `openai/gpt-oss-20b` | used when the fallback is itself rate limited; `none` switches it off |
| `AI_REASONING_EFFORT` | unset | optional `low` / `medium` / `high` for the fallback |

**Prompt caching.** The system prompt is in two parts. The first (who Tony
is, what he can do, his rules) and the tool definitions are the same for
every message, so they are marked for Anthropic's cache; the second (the
time, your tasks, memory) changes and comes after it. A message sent within
five minutes of the last one reads the first part from the cache at a tenth
of the normal input price. Each call logs how many tokens were read from and
written to the cache.

Each message is kept small (Groq's free tier, the fallback, allows 8,000
tokens a minute for its model): a short prompt, only the tasks and memory notes that
bear on the message, six clipped turns of history, and a confirmation written
in the same call as the action, so most messages cost one model call.

When Groq, as the fallback, answers 429, Tony keeps "typing…" showing, waits the time
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
