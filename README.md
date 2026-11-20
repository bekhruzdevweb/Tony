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
| R | Reliability: verified replies, each request handled, safe failures, nothing lost, en/uz/ru voice, act first, eval suite | Built, awaiting your check |
| D | How Tony decides: routine profile, decide vs ask, check-ins, links in notes | Built, awaiting your check |

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

**The pinned Today message.** One message, pinned silently, sent as a
Telegram rich message (Bot API 10.1+, `sendRichMessage`):

    Today · Fri 20 Nov                (heading)
    1/3 done                          (small, italic)

    ☐ ⚠️ Wed 23:29 Reply to the school
    ☐ 18:00 English Speaking Club
    ☑ 09:00 Morning walk              (native checkboxes; done at the bottom)

    [✓ Reply to school] [✓ Speaking Club]
    [➕ Add]            [📱 App]

The list uses Telegram's own checkboxes, ticked for what is done. Telegram
does not tell a bot when someone taps one of those (Bot API 10.4 has no
such update), so ticking is done with the buttons inside the message (Bot
API 10.3): one short "✓" button per open task, two to a row ("Attend English
Speaking Club – More Than a Game" → "✓ Speaking Club"). A tap ticks the
task off in plain code and the same rich message is edited, so its checkbox
fills in. If you tap a checkbox itself, Telegram may tick it on your screen
only; the next edit puts it back to the truth.

It redraws itself after every message, tap, reminder tick and change made
in the app, but only talks to Telegram when something changed. A fresh one
arrives with the morning brief; `/today` (also `/checklist` and `/list`)
sends a new one and pins it. Either way the previous board is unpinned and
deleted, so there is only ever one. Its message id lives in settings, with
a note of which form it was sent in.

If Telegram refuses the rich message, the board is sent as before: the
day as text (`☐ 18:00 English Speaking Club`, done items `☑` struck
through at the bottom) with short buttons, two to a row.

**The coach.** Repeating tasks (daily, weekdays, weekly: "work out every
day at 18:00") are habits. Each time one is done or skipped, the day that
occurrence was due goes into `habit_log`. From that log alone Tony works
out, per habit: the last day it was done, the current streak, the best
streak, and the due days missed this week. Nothing before tracking began
(`settings.habits_since`) or before the habit was set up counts as a miss,
and a skipped day neither breaks a streak nor adds to it.

- **Morning brief (08:00).** The spoken part is today's key tasks and one
  personal line from the log ("It's been 4 days since your last workout,
  sir; your best streak was 9. One today puts you back on track."), kept to
  about 300 characters. The text has the full day plus a 🔥 Habits section
  with each habit's facts.
- **Nudges**, at most two a day and never in quiet hours: a habit that is
  slipping or is a key task, due today and not started, 30 minutes before
  its time; a key one-off task likewise; and a habit missed
  three due days or more in a row, once a day from 10:00 (unless it is due
  later that day, when the 30-minute nudge speaks to it instead). Each is a
  short voice note with its words as a caption.
- **Tone.** Warm on a streak, firmer when a habit slips, never shaming.
  Every sentence is a fixed template filled with numbers from the log; no
  model writes them, so no number is made up. The brain is given the same
  facts and told to quote only those.
- **Voice budget.** (Nudges are spoken within the voice rules above, else
  sent as text.) Every character sent to ElevenLabs is counted for the
  month (`settings.tts_chars`). Tony also reads the plan's own usage and
  limit when the key is allowed to (they include anything spoken outside
  Tony); otherwise he uses his own count against `ELEVENLABS_MONTHLY_CHARS`
  (default 10,000, the free plan). Past 80%, only the morning brief is
  spoken: replies and nudges go as text. Tony's own count resets on the 1st;
  ElevenLabs resets on your billing date.

Needs migration `0011_coach.sql` (applied).

**Talk mode.** Tony first decides whether a message is talk (chat,
opinions, ideas, debate, a joke, a question about the world) or a request
about his tasks. In talk he simply converses, as Jarvis: views of his own,
dry humour, a follow-up question now and then, "sir". Talk never creates a
task. When something sounds actionable ("I should film that series"),
Claude calls `offer_task`, which creates nothing: a **➕ Make this a task**
button appears under the reply, and only the tap creates the task (plain
code, in the inbox, or at the time he named). When unsure, it is talk.

**Long-term memory.** When he mentions something lasting (a project, a
goal, a person, a preference, a routine), Claude saves it with `remember`
alongside its reply, without asking; moods, one-off plans and trivia are
not saved, and the same fact is never stored twice. The twelve notes most
relevant to each message are given to Claude, to use naturally.

**Web.** Claude has Anthropic's web search (up to 3 searches per reply,
located in Tashkent) and web fetch (up to 2 pages). Haiku takes the basic
tool versions (`web_search_20250305`, `web_fetch_20250910`). The pages an
answer cites are listed under it as **Sources** links. A long search that
pauses is resumed. If the account refuses the web tools (they can need
enabling in the Anthropic Console), Tony answers without them and tries
again an hour later.

**Links.** Send a link and Tony reads the page and sums it up (a line on
what it is, then the key points). Under the summary: **💾 Save** keeps it
as a memory note ("Saved link: title (url). summary"), so "what was that
grammar article?" finds it; **➕ Task** adds "Read: title" to the inbox with
the link in its notes. Both are plain code and work once each. These offers
are kept in the `offers` table (migration `0013_offers.sql`, applied).

**Prayer times.** For where he lives, a setting (`/location`; by default
Xonqa tumani, Xorazm viloyati). The official times of the Muslim Board of
Uzbekistan come from namoz-vaqti.uz (`/lotin/namoz-vaqtlari/<region>/oylik`,
a table of the next month or so). Tony stores it in `prayer_times` and
fetches it again only when today is missing from it, so about once a month.
Every day from 00:05 today's row becomes Fajr, Dhuhr, Asr, Maghrib and Isha
in a **Prayer** project, each with a quiet note 10 minutes before (silent)
and one at the time with **✓ Prayed**. If the site cannot be read, Aladhan
by the location's coordinates stands in (method 3, Hanafi Asr) and those
reminders end in "(approx.)".

They are calm by design: one line on the Today board and a strip of chips
in the app (tap to mark prayed), never counted as tasks, never overdue,
never chased, planned around or spoken; an unticked prayer is closed
quietly at the next day's fetch. `/prayer` shows today's times; `/prayer
on|off`; `/prayer hanafi|standard` and `/prayer method N` shape the
fallback. `/location Xiva shahri` moves to another region (checked against
the site first, today's remaining prayers re-timed); `/location 41.47 60.78`
sets the fallback coordinates. Migrations `0016_prayer.sql` and
`0017_prayer_location.sql`.

**Reliability.** Tony only claims what is stored:

- After any task change the task is read back from the database and the
  reply is built from that, one line per change ("✓ **Call the barber** →
  tomorrow **08:30**"), never from what the model said it would do.
- Every request in a message is handled (the newest message is marked as
  the one to act on); "this one" with nothing replied to means the
  reminder sent in the last 15 minutes. Several requests, or moving and
  planning things, go to Claude Sonnet 5.5 (`ANTHROPIC_DEEP_MODEL`); simple
  replies to Haiku.
- A reminder after a task's time moves the task (a reschedule); one before
  it is an extra heads-up; the same reminder twice is never added.
- Adding or moving a timed task checks for clashes (within 30 minutes, or
  overlapping by duration) and offers **Move … HH:MM** (only a free time)
  and **Keep both**. The morning brief and `/plan` flag clashes too.
- "Save this" with a link saves it at once as a bookmark with the page's
  real title; a link or note never gets a date unless his words give one.
- "Here it is" is only said once Telegram has confirmed the photo or file
  was sent; "clean the chat" runs the `/clean` sweep.
- Regression tests for each of these: `npm test` (Vitest, `tests/`).

**Smart scheduling.** Every task gets a length (his, Claude's estimate, or
a guess from the title). Free time is found in plain code
(`src/lib/schedule.ts`): other tasks block their length, prayers ±15
minutes, and the day runs from the end of quiet hours to their start
(07:00 to 23:00). The most important go first, deep work in the morning
and light tasks from the afternoon, with a 10-minute gap between things.

- Tasks given without times for a named day ("tomorrow I need to do a
  presentation and a zoom tutorial") become drafts and are proposed all at
  once as a table (Time · Task · Length) with **✓ Looks good** /
  **✏️ Change**; nothing is kept until he confirms. With no day named,
  they go to the inbox with one suggestion.
- `/plan` and "plan tomorrow" use the same placement. Asked late (after
  20:00, or under two free hours left) `/plan` plans tomorrow and says so;
  a full day rolls on to the next. Overdue tasks get slots, and any it
  cannot place get **→ Tomorrow** / **Drop** and **Move all to tomorrow**.
- Migrations `0018_plan_lead.sql` and `0019_task_drafts.sql`; subtasks need `0020_subtasks.sql`.

**Tony's replies.** Everything the brain says in Telegram is a rich
message written in Telegram's rich markdown. The system prompt tells
Claude how to lay it out, with two worked examples:

- at most two short sentences of prose, the first summing the answer up;
- three or more items as a list, never a paragraph (tasks as a native
  checkbox list, `- [ ] Title`);
- a schedule as a small `| Time | Task |` table;
- short headings for sections;
- bold only for times and a key word or two (Tony also bolds every time
  and, in a confirmation, the task's title);
- questions as buttons: Claude calls `ask` with options. If a reply still
  ends with a yes-or-no question ("Shall I move it to tomorrow?"), Tony adds
  **Yes** / **No** buttons himself.

When you spoke to him, the voice note says only the prose (the summary
sentence), never the list or table; those stay in the chat. If Telegram
refuses the rich message, the same reply goes as HTML (lists as lines,
tables as rows). The app's chat shows the reply as plain text. The
no-repeat guard covers rich messages too.

**Rich messages elsewhere.** The morning brief and plans (`/plan`, "plan
my day") are rich messages too: a heading, sections as lists, the plan's
reasoning in a folding quotation, and the plan's buttons under it.
Adjusting a plan edits the same message. Both are written once as HTML and
converted (`src/lib/rich.ts`); if Telegram refuses the rich form, the HTML
is sent as it is.

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

**When Tony speaks.** `/voice on|off|auto` (default **auto**).

- **auto**: a voice note only for (1) the morning brief, (2) nudges that
  matter: a habit missed 3+ due days in a row, or a key task (persistent, or
  priority 1-2, habits included) due in 30 minutes and not started, (3) a
  persistent reminder's final call, said aloud when two nudges went
  unanswered ("Final call, sir: Gym session. It was due at 18:00."), and
  (4) whenever you ask. At most 3 a day, not counting the ones you ask for;
  past that, the same words go as text. Replies to your voice notes are
  text.
- **on**: all of the above with no daily limit, and voice notes are answered
  aloud.
- **off**: Tony speaks only when you ask.

Asking means words like "say it", "voice", "tell me", "read it out" or
"out loud", typed or spoken; that reply is then also spoken, as its short
prose summary. `/voice` on its own shows the mode and today's count.
Separately, past 80% of the month's ElevenLabs characters only the morning
brief and what you ask for are spoken. What is said aloud is whole
sentences, up to about 300 characters; the detail is in the text.

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

### Subtasks

A task can have parts. When a request lists them ("stories about the app,
the club and the grammar series", "presentation: slides, examples, quiz"),
Tony saves them as subtasks of the task, not as notes, and keeps every
detail you gave in the first message without adding any of his own. Say
"I finished the slides" and he ticks that part.

- The `/today` board and reminders show the progress ("Post stories 1/3")
  with the parts listed under the task, and a ✓ button for each open part.
- When the last part is ticked, Tony asks before marking the task itself
  done: [✓ Mark done] [Not yet].
- In the app, parts sit under their task with their own circles, the
  progress next to the date, and "+ Add subtask" (also in the long-press
  menu).
- Lists already written in a task's notes were moved into subtasks once,
  on the first tick after this change.

## Reliability

Built from an audit of his first 218 messages. Each rule is checked in code,
not left to the model, and each has an eval case made from the real message
that broke it.

1. **Verified replies.** After every write, the task, reminder, note or
   bookmark is read back from the database, and the reply is built from what
   is stored. A field that did not save is reported ("⚠️ the notes did not
   save"). If nothing was written, any sentence claiming otherwise ("Noted,
   sir. Reminder set…") is removed.
2. **Several requests in one message** ("…? And also…", ". Also…", "clean the
   chat and send me…") are split, handled one by one, and each gets its own
   confirmation. "Clean the chat" runs in plain code. A request that is not
   clearly separate stays whole.
3. **When the AI fails**, Tony tries once more. If it fails again he says so
   and saves nothing; your words never become a task.
4. **Nothing from your first message is lost.** Any link, and your own words
   when details were dropped from the title, go into the new task's notes.
5. **Voice notes are read as English, Uzbek or Russian.** If Whisper guesses
   another language, the note is read again as each of the three, and the
   most confident reading wins.
6. **Act first.** A task with no time goes to the Inbox, and Tony does not ask
   for one. If you named a day, a 🧭 Find a time button offers slots; nothing
   is placed without your tap. The times you give are final: if the model
   writes another, yours is put back. At most one question per reply.
7. **Eval suite** (`evals/`, `npm run eval`). Real messages are replayed
   through the whole brain against an in-memory copy of the database schema
   (read from the migrations). The model is scripted to repeat its real
   mistakes. `npm run build` runs every test first (`prebuild`), so a failing
   case stops the deploy.

## How Tony decides

**Your routine** is one profile (`/routine` shows it): when you wake and sleep,
your hours for teaching, content, coding and workouts, your free days, and your
prayer times (always kept clear, ±15 minutes). Tell Tony in your own words ("I
teach Mon–Fri 14:00–18:00", "content 10–12", "Sunday is my free day") and he
saves it. When you move a task to a time yourself (in words, with a button, or
in the app), he learns that this kind of task belongs around that time. Kinds
are content, coding, teaching, lesson prep, watching and reading, workouts,
errands, and other.

**Decide or ask:**
- **You gave a time:** it is used exactly and never questioned. If it overlaps
  something, Tony says so ("⚠️ Workout and the Zoom tutorial are both at 18:00")
  and offers [Move … 19:15] [Keep both]. He never asks.
- **No time, no day:** the task goes to the Inbox. No time is proposed unless
  you ask.
- **A day but no time:**
  - If your routine clearly fits, Tony proposes one slot: "I'll put **Post
    stories** tomorrow at **10:00**, your content time." [✓ 10:00]
    [✏️ Change]. A routine clearly fits when you named part of the day ("Sunday
    evening"), you usually do this kind of task at a certain time, or it has
    its own hours in your routine.
  - If not, he asks once, with 2–3 real free slots as buttons.
  - If the model writes a time you never gave, it is removed in code and the
    rule above applies.
- **Several tasks for one day:** one plan in one message, [✓ Looks good]
  [✏️ Change].
- **Never two things in one slot:** every task blocks its whole duration, with
  10 minutes kept clear around it. This covers his proposals, the buttons, the
  planner, the "Move to" times on reminders and the overdue suggestions.
- **Today, Tomorrow and This weekend buttons:** the task keeps its own time if
  that is free; otherwise your routine decides.

**Style:** one short message per request, at most one question. When Tony is
unsure what you want, he says what he will do ("I'll remove **buy notebook**.")
with [✓ Do it] [✏️ Change]. ✓ runs it in plain code and confirms it from what
is stored.

**Check-ins:** "Remind me if I don't check it for 2 days" makes a check-in. It
goes out only if the task really sat untouched that long, with [✓ Done]
[Tomorrow] [Drop], and comes back every 2 days. If you touched the task, it
waits 2 days from then. At night it waits for the morning.

**Links:**
- A link you send with a task, or in the message just before it, goes into
  the task's notes. A title that says nothing ("Watch the video") gets the
  page's title.
- The confirmation says so: "✓ **Watch: …** → Mon **10:00** · 🔗 link saved".
- Tony never asks whether to attach a link you sent.
- "Send me the video" or "what was the link?" is answered with the link itself,
  at once, in plain code.

Migration `0021_routine.sql` adds the routine profile and check-ins. Your waking
day is copied from your quiet hours, and workouts are set to 18:00–20:00 (from
"I work out in the evenings" and "work out at 6 pm"). Everything else starts
unset until you tell Tony.

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
