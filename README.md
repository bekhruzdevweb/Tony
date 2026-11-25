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
| R | Reliability: verified replies, each request handled, safe failures, nothing lost, en/uz/ru voice, act first, eval suite | Passed |
| D | How Tony decides: routine profile, decide vs ask, check-ins, links in notes | Passed |
| P1 | Reliability II: change history and /undo, notes appended, receipts with attachments, send-now, night rule, memory hygiene and /memory | Live, awaiting your check |
| C1 | Change 1: a day without a time is always asked (2–3 free slots, best first with a reason, Other), "decide yourself for <kind>", split for long tasks | Live, awaiting your check |
| P2 | Personality: companion and advisor first, natural replies with a small receipt line | Live, awaiting your check |
| P3 | Smart context: bursts, library, situation rules ("when X, do Y"), 🌙 Free Time list and suggestions, follow-up ladder | Live, awaiting your check |
| P4 | Safety and monitoring: self-test, budgets, backups, catch-up, notification budget, 👎 mistakes | Live, awaiting your check |
| R | Guided weekly planning in Telegram: `/week`, or [🗓 Plan week] on the pinned board. One message redrawn at each step: the week's outcomes first, then each waiting inbox task alone with the days left (a day, keep in the inbox, someday, or drop); after a day, "one of that day's three urgent tasks?" until three are taken. Every step is a button in plain code (`settings.week_session`, migration 0036) | Awaiting his check |
| Q | Dashboard, Big 3 and time blocks: Today is a dashboard (three counters, Today's Big 3 with a Tomorrow switch, the week's outcomes, a timeline that holds only what has a time, a focus timer; everything else folded in one list); three tasks a day at most are chosen as the Big 3 (`tasks.big3_on`, migration 0035, the `big3` tool, 21:00 "which three for tomorrow?"); big focused work with a time is a block with a length, small things get no time; a Calendar page shows the week | Awaiting his check |
| P | Weekly planner: a page in the app with the week's outcomes (three to five, `week_goals`, migration 0034), the inbox by life area (tap a task, then its day), the week's calendar and a line to ask Tony; Tony keeps outcomes with `week_goal` and sees them in his prompt; Sunday 19:00 he invites him to plan the week ahead | Awaiting his check |
| O | Life areas and references: his projects are his areas (Content creation, Teaching, IELTS, Health, Business, Personal development, Prayer) and every new task gets the one it belongs to; something shared to work from later ("make a reel cover like this") is kept as a reference in its area with no task and no reminder, and Tony offers it when a task is really the same thing (migration 0033) | Awaiting his check |
| N | Quiet capture and calm reminders: a new thing with no day goes to the inbox with one receipt line and three buttons under it: Set a time, Schedule, Inbox; every reminder comes at its time and once more an hour later, replacing the first, then nothing until the evening review. The urgent ladder, the main priority's chase and the same-day "still open" message are switched off (`CALM_REMINDERS` in `src/lib/calm.ts`) | Awaiting his check |
| M | Layered memory: this week, this month, always; goals first in plans and the brief; Sunday review that moves up what held and drops what went stale; /memory by layer | Live, awaiting your check |
| MP | Main priority: the one thing chased until it is done (nudges every 30 min, hourly when unanswered, never at night, 8 a day), ⭐ in the brief | Live, awaiting your check |
| F | Fixes from 22 Nov 12:37: plans are not habits, "this task" is the one just touched, replies are read as about the message, a clean chat after a tap, lists you can tick, a day column in week plans, every PDF in an album read, renames read back | Live, awaiting your check |
| L | Lessons and replay: his corrections are kept as "Lesson:" notes that Tony's model is always shown and must follow; the model sees up to 80 open tasks (matched on notes too); a read-only replay (/api/replay) puts his past messages to the model again to check its decisions; model is Opus 5.5 (ANTHROPIC_MODEL) | Live, awaiting your check |
| K | Free Time finds its day: each morning, Free Time items go onto light days of the coming week (fewer than 4 tasks), one a day, three at most, with [↩ Back to list]; a day he named that is full is asked about ([No time] [Other time] [Later day] [Inbox]), never sent to the inbox; one question per task | Live, awaiting your check |
| J | Calm and clear: every line on its own line, 3+ receipts as one short list; after midnight the day just begun is "today"; small things get no time ("anytime", one quiet check at 20:00); three priorities (urgent is chased 15 min after its time, then hourly, until he answers or it is done; important; normal); no clash for two things he put together | Live, awaiting your check |
| I | Smart inbox: a new thing with no day gets the first day that is not full (7 tasks) at its best free time, one tap to set ([📅 Later day] [✏️ Other time] [📥 Inbox]); the evening poll keeps its day after midnight and sends overflow to the next free day; a yes to Tony's question runs it, several proposals are one ✓; videos are read (cover frame and speech); kept files named in reminders; "forget this file" works | Live, awaiting your check |
| H | Habits and organizing: habits you choose with streaks (/habits, reminders, the board, Sunday's week), plans' progress, tags (#content), the Plan board (Today · This week · Someday); a short call inside a long block is not a clash | Live, awaiting your check |
| M | App: bright Apple-style theme, pictures, motion; Today as List or Week (seven days side by side, each a short list), the list in three boxes (Urgent, Important, Small tasks) | Awaiting his check |

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
not saved, and the same fact is never stored twice. Since 22 Nov notes live
in three layers (this week, this month, always; spec: "Layered memory"):
every reply sees all live week and month notes and the twelve always notes
most relevant to the message; a repeated note is confirmed, never copied;
goals come first in plans and the morning brief (🎯 Focus); and every Sunday
at 21:30 a review moves up what held, drops what went stale and sends three
lines with ↩ to keep what was dropped.

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
| A reminder you tapped Done, Skip, Snooze or a new time on, with the task's other reminders | at once (the outcome shows as a note on the screen) |
| A question about a time, once you tap one | at once (the outcome shows as a note on the screen) |
| A follow-up ("⏰ Still open…"), a question about a time, or a receipt | once every task in it is done, dropped or moved on, however you did it |
| A "thirty minutes" heads-up before a task | at the task's time, when its reminder takes over |
| A task's example (the post you kept with it) and its notes | with the task's reminder |
| A prayer's message | when the next prayer's comes |
| A receipt for something done or moved in your own words | after 2 minutes |
| Any other confirmation ("Noted, sir…") | after 3 hours (24 hours if it answered a voice note) |
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

## Reliability II (Phase 1)

From an audit of 275 real messages and the database. Every rule has a test
made from the message that broke it; `npm run build` runs them all first.

- **Every write is read back.** Tony re-reads each new task, move, completion,
  attachment and note before he confirms it, and the reply is built only from
  what is stored. "Here it is, sir" is said only after Telegram delivers the
  photo; otherwise those words are removed.
- **Notes are added to, never replaced.** Task 11 lost its first podcast link
  this way.
- **Every change is kept.** The database records each change to a task, made
  by Tony, a button, the app or the clock, as the row before and after.
  `/undo` lists the last ten in plain words, each with ↩. A tap puts back
  exactly what that change changed and leaves later changes alone. Typing
  "undo that" opens the same list.
- **Receipts show what a task holds:** "✓ **Watch: …** → Mon 23 Nov,
  **10:00** · 🔗 link · 🖼 1 photo". Tony's own task list shows notes and
  attachments too.
- **"Send me that photo / the video / the link"** is answered in code, at
  once: the original or the link, never a question about it.
- **Night rule.** Between 00:00 and 05:00, "tomorrow" (or "tmr") means the day
  after you sleep. Every confirmation names the weekday and the date ("tomorrow,
  Sat 21 Nov, 08:30").
- **When the AI fails twice,** Tony says "I didn't catch that, sir.", saves
  nothing, and logs the failure (`events`).
- **Memory holds only what you said.** Tony refuses a "fact" that is not in
  your own words (a guess, or something from his own reply), and the 💾 Save
  button stores only a link and its title. `/memory` lists everything he
  keeps, each with 🗑.
- **No talk of internals.** Sentences about tools, filters or errors are
  removed from his replies.

Migration `0022_history.sql` adds `task_history` (with its trigger) and
`events`.

## Change 1: a day without a time is always asked

- **One question, never a silent pick.** "Watch it on Monday" gets one
  message: the task, "When on Mon 23 Nov? Best: **20:30**, you usually watch
  videos around 20:30.", what shapes the day ("10:00–14:00 is taken by
  **Watch: Instagram Masterclass**"), and buttons: the best first (⭐), two
  more from other parts of the day, and [✏️ Other time]. Nothing is stored
  until you tap or type a time.
- **Best first, with its reason:** the part of the day you named ("Sunday
  evening"), then the time you usually do this kind of task, then its hours in
  your routine, then the first free time.
- **"Decide yourself for <kind>"** (videos and podcasts, study, content,
  coding, workouts, errands, lesson prep, classes) lets Tony pick the time for
  that kind himself; the receipt says it was his pick and why, with
  [✏️ Change]. "Ask me again for <kind>" turns it off. `/routine` shows it.
- **[✏️ Other time] sends no extra message.** The question shows it is waiting;
  a plain time you type next ("20:30", "8 pm") is placed in code, no AI.
- **Learning:** from times you type on new tasks, slots you tap, moves, and
  tasks you finish (when you started them).
- **A long task with no gap for it** (a 4-hour video) is offered in two halves;
  it is split only if you tap [✂️ Split …].
- Today/Tomorrow/Weekend buttons on a task with no time ask the same question;
  "Plan tomorrow", `/tomorrow` and "move overdue to tomorrow" follow the night
  rule.

Migration `0023_decide.sql` adds `routine.auto_kinds` and
`settings.pending_slot`.

## Personality (Phase 2)

- **A companion and advisor first,** a task manager second: opinions,
  explanations, disagreement, humour, and a real follow-up question in words
  when it helps. "Sir" now and then, not in every reply.
- **Length fits the question:** one line for "add milk", a full, structured
  answer for "help me plan my course launch". Advice and discussion get more
  thinking time and room; Tony remembers the last 10 turns, each up to 1,200
  characters (was 6 × 280).
- **Tasks happen quietly:** a plain request (add, move, remind, attach,
  remember) gets one small receipt line built from what is stored ("✓ **Call
  the barber** → tomorrow, Sat 21 Nov, **08:30**") and nothing else; only
  "persistent mode on" still says itself (22 Nov: a comment about the
  screenshot made a reminder too long). When you also ask what Tony thinks, his
  words stay above the receipt, less any sentence that claims an action, names
  a time that is not stored, or mentions tools. A note is read back in the
  receipt only when it is your own words, and a clash is told once.
- **After midnight** the day just begun is named your way: "tmr" gives
  "tomorrow, Sun 22 Nov", "today" gives "today, Sun 22 Nov", and with no day
  word, just "Sun 22 Nov".
- **What you share comes back together:** "send it as a preview" (or "both")
  sends everything kept with that task as one album, under the task's name and
  your own words; "send me the video" sends the video only. A file goes back
  under your caption or the task's name, never the description Tony read.
- **PDFs and text files are read** (22 Nov: "can u see my ielts plan?"): the
  PDF's own text, whole, taken in code in under a second (Claude reads only a
  scanned PDF), with a one-line summary; given to Tony as material (never as
  your words). The library names the file and says what it is about; Tony
  reads a long one page by page (`library read` with `from`). A PDF kept before
  this is read again from its stored copy by the minute tick, once.
- **A plan into your schedule** ("add it to our plan"): its sessions become
  repeating tasks that end on the plan's last day (`repeat_until`, migration
  `0027_repeat_until.sql`), "🔁 weekly until Sun 17 Jan 2027" in the receipt;
  with no time of yours, one plan over the week is proposed, each session kept
  on its own day. "Preview" after that shows the schedule, not the file.
- **Tony keeps the end of his own long answers** in the conversation (the
  start and the end of anything over 1,200 characters), so a "yes" to his
  offer is understood.
- **Buttons only for real task actions** (choosing a slot, confirming a
  change); a question in conversation is answered in words.
- **Your words for titles:** Uzbek or Russian stays exactly as you wrote it
  ("Zamokli ko'ynak olish" is never "Buy a zippered shirt").

## Main priority (MP, 22 Nov)

Your idea: the one thing Tony does not let you leave unfinished.

- **Setting it:** "make IELTS my main priority" (for a plan's sessions, all of
  them: one is chased each day). One at a time: a new one replaces the last.
  "Stop chasing it" clears it. Stored as `tasks.main_priority` (migration
  `0029_main_priority.sql`).
- **The chase** (the minute tick, plain code): from 30 minutes after its time,
  if it is not started or done, a nudge every 30 minutes; after two you did not
  answer, every hour. Never in quiet hours, at most 8 a day (the last one says
  it stops for today). One with no time, or left from an earlier day, is chased
  from 10:00. It never comes on top of its own reminder, and the "still open"
  follow-up leaves it to the chase.
- **The buttons** are the reminders' own: ▶️ Starting now (quiet for its length,
  an hour without one, then "Done?"), ✓ Done (a repeating session comes round
  on its next day), ⏰ In 1 hour, Not today (a weekly session is skipped to its
  next week; anything else moves to tomorrow). Every tap counts as an answer.
- **The morning brief** names it under the greeting: "⭐ Main priority: … · 09:00".

## Free Time finds its day (K, 23 Nov)

- **Light days.** At 09:30 Tony looks at the next seven days from tomorrow. A day with fewer than 4 tasks (prayers not counted) is light. The Free Time items waiting longest go there, one a day, three at most in one go, each at the best free time. He is told once, with [↩ Back to list] for each; one sent back is left alone for two weeks.
- **His day is his.** A task he names a day for is never put in the inbox because the day is full. Tony says the day has no free slot and offers [No time] (one reminder at 20:00), [✏️ Other time], [📅 Later day] and [📥 Inbox].
- **One question per task.** A new question about a task replaces the older one.

## Calm and clear (J, 23 Nov)

- **One line, one thing.** Markdown joins single lines into a paragraph, so Tony's replies are sent with each line kept apart. Three or more receipts are one short list, and a repeat they share is said once under it.
- **"Today" after midnight.** At 04:27 Monday is "today, Mon 23 Nov" in everything Tony writes. If he says "tmr" at night, the same day is still named "tomorrow", his way.
- **No time.** Tony always asks when a task has no time, and every such question has a [No time] button next to the times. Tapped (or when he says "no need for a time"), the task goes on that day with no time: shown as "anytime", it takes no time from the day and gets one quiet check at 20:00 ([Done] [Tomorrow] [Skip]). A tap turns the question into its receipt, kept 3 hours.
- **Three priorities.** Urgent (1) means it must be done that day: a reminder at its time, again 15 minutes later if he does not answer, then every hour until he answers or it is done. Quiet hours end it. "Busy, in an hour" moves it, and the chase starts again from there. Important (2). Normal (4, the default). The app shows Urgent, Important and Normal.

## Smart inbox (I, 23 Nov)

- **A suggested day.** Something with no day ("I want to shoot videos like this" + a link) is saved, and Tony asks once: "When on Wed 25 Nov? Best: **15:00** … Mon 23 and Tue 24 Nov are full." A day is full at 7 tasks (prayers not counted). The search starts today, or tomorrow after 20:00, and goes up to two weeks ahead. One tap sets it, the question leaves the chat, and the reminder comes on that day with the link and files. [📅 Later day] looks at the next day with room. [📥 Inbox] keeps it unplanned. "Put it in the inbox", "someday" and "just save it" skip the question.
- **The evening poll** ("Which ones tomorrow?") is how undone tasks move on: Tony asks, and what he ticks goes on that day, each at its own time of day, or with no time if it had none. Nothing is sent to another day because the day looks full (23 Nov 21:28). A vote after midnight still plans the day the poll asked about. What he does not tick stays where it is and is asked about again in the morning brief.
- **Tasks with no time** do not ring one by one: one calm line names them in the evening, and the evening review lists them as "no time", never as late.
- **A yes is a yes.** "Yes, remove them all" to Tony's own question runs every change. Several proposals in one reply are one question with one ✓.
- **Videos are read** by their cover frame and what is said in them. Videos kept before this are heard in the background. A reminder names each kept file ("📎 file: an 8-week IELTS Academic study plan (below)"). "Forget this pdf" deletes the file.

## Habits and organizing (H, 22 Nov)

- **A habit** is one you choose: "make reading a daily habit at 21:00", "I want
  to stretch every morning as a habit" (no time: Tony asks it), or 🌱 Habit on a
  repeating task in the app. "Stop tracking reading as a habit" ends it. A
  plan's sessions (IELTS, the workout plan) and chores are never habits.
- **Its run**, always from the log: under its reminder ("🔥 3 days in a row:
  keep it going"), in its Done ("✓ Done, sir. 🔥 4 days in a row"), on the
  Today board ("Reading 🔥4"), in the app's 🔥 Habits screen (the last two
  weeks, ✓ Done today), and in **/habits**: each habit's week (✓ done, –
  skipped, ✗ missed, ○ today, · ahead), its run and best, a ✓ for each still to
  do today, then your plans this week ("IELTS · 2/3 done").
- **Sunday's "The week"** adds the habits' week and the plans' progress.
- **Tags**: write "#content" with a task, or "tag it ielts"; a titled series is
  tagged by its name ("IELTS: …" is #ielts, "Workout: …" is #workout). "Show my
  content tasks" lists them; the app shows the tags on each task and under
  Filters & Labels, and the task sheet edits them.
- **The Plan board** (app: the sidebar, or Tony's picture → 🗂 Plan board on a
  phone): Inbox, Today, This week and 🌙 Someday, with → Today / → This week /
  → Someday under each task. A task keeps its time of day where that is free;
  one without a time gets Tony's best free time; Someday clears its date and
  reminders. In words: "park it", "someday", "move it to this week".
- Migration `0031_habits_and_tags.sql` (tasks.habit, tasks.tags).

## Fixes from 22 Nov 12:37 (F)

- **Plans are not habits.** A repeating task with an end date (`repeat_until`:
  the IELTS sessions, the 12-week workout plan) is one of a plan's sessions,
  not a habit: no streaks, no "missed" counts, no 🔥 lines in the brief. A
  habit's day counts only from its first date (the Sunday review first due
  29 Nov was "at 10:00" on 22 Nov). A session due within 30 minutes still gets
  its one spoken heads-up as a key task. Habit lines with nothing to report are
  left out of the brief.
- **"This task"** means the one touched last in the last 15 minutes: a
  reminder, or a button he tapped (▶️ from the free-time question, Done, a
  move). An older reminder is named as not the one.
- **Replies.** A reply to any of Tony's messages (a coach nudge, a voice note,
  a list) is read as about that message; Tony answers about that only.
- **A clean chat.** See the tidying table: tapped reminders go a minute after
  the tap; follow-ups, time questions and receipts go once their tasks are
  settled (`chat_messages.task_ids`, migration `0030_chat_message_tasks.sql`).
- **Lists you can tick.** A task list in a reply gets "✓ Done" at the end of
  each line that names one of your open tasks (a tap on Telegram's own box is
  never reported to the bot); "↩ Undo" puts it back. Lines that are not tasks
  are plain bullets. "What do I have to do?" shows today; a subject or a day you
  name is all that is shown.
- **Week plans** show each row's day ("Mon 23 Nov · 18:00 · Upper A").
- **Albums of files**: every document in an album is read, not only the one
  with the caption.
- **Renaming**: "change the title of Call barber to Call Akmal the barber" (or
  "rename it to …" right after a reminder) reads back `✏️ ~~old~~ → new`.
- **Downloader captions** ("Спасибо, что пользуетесь - @SaveAsBot'ом") never
  appear under a reminder.
- **The morning brief's clashes**: one line per group of clashing tasks, three
  at most.

## Smart context (Phase 3)

- **Bursts:** what you send within a minute (a screenshot, some words, a link,
  in any order) is one request. Tony waits about four seconds after your last
  message, then answers once, for all of it.
- **Library:** every link and forwarded post is kept with what it is; photos,
  videos, files and voice notes already were. "Send me that Instagram video" or
  "the photo I sent yesterday" finds it by what you call it. Only when two
  truly fit does Tony ask, showing both titles.
- **Your label is the key:** a file you filed under a name ("ideas for my
  reels", "motivation video") is sent by that name at once, in plain code,
  with no guessing. If you say "no, I didn't mean this one", what was just
  sent is never sent again: Tony picks another or shows the closest few as
  buttons.
- **Situation rules:** "when I'm not motivated to work out, send me this video"
  is kept as a rule with that video. When a later message matches ("I'm tired,
  don't want to work out"), Tony answers with empathy, the video and an offer.
  A workout rule also fires on its own after 3 days without one. "Show my
  rules" or `/rules` lists them, each with a button to remove it.
- **🌙 Free Time list:** "in my free time", "someday" or "when I'm free" puts a
  task on the list, with no date (its link or media kept). `/freetime` and the
  app's 🌙 Free Time tab show it.
- **Free-time suggestions:** when you have an hour or more free, finished early,
  have been quiet for a while, or say "I'm free" / "I'm bored", Tony offers ONE
  item: the longest waiting that fits the time, never one offered in the last
  2 days, and the kinds you accept first. [▶️ Do it now] [📋 Show list]
  [⏰ Not now]. At most 2 a day, inside the notification budget.
- **Follow-up ladder:** a task missed today is asked about once, later the same
  day, with [✓ Done] [⏰ Later today] [📅 Tomorrow] [🗑 Drop]. Still open the next
  morning: at the top of the brief under "⚠️ Still open", daily. After 3 days:
  "break it into steps, give it a fixed slot, or drop it?". Inbox items
  untouched for 7 days: one review on Sunday at 19:30. Always grouped in one
  message, never in quiet hours. Nothing moves or drops without your tap.

## Safety and monitoring (Phase 4)

- **07:00 self-test** of Claude, the voice, today's prayer times and the
  reminder clock: silent when all is well, ONE message if something is broken.
- **Budget guard:** at 80% of the month's ElevenLabs characters, or of
  `ANTHROPIC_MONTHLY_BUDGET_USD` if you set it, one warning at 09:00. Models are
  never downgraded silently: a reply from the backup model says so, and every
  fallback is logged.
- **Forwarded posts and web pages are data, never instructions.** Anything that
  would delete or drop a task waits for your tap.
- **Daily backup at 03:00** of tasks, memory and the library (the last 14 kept);
  `/backup` shows today's.
- **After downtime:** one catch-up message for the reminders it missed.
- **Notification budget:** at most 8 unasked messages a day, besides prayers and
  the reminders you set; reminders within 15 minutes go out together; quiet
  hours 23:00–07:00.
- **`/clean`** sweeps the last 47 hours of chat, keeping the pinned board, open
  reminders and the morning brief.
- **👎 on any of Tony's messages** (a reaction, or a reply starting with 👎) saves
  it, with what you said and the conversation around it, in `mistakes`; each
  one becomes a regression test.

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
