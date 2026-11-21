# Tony v1 — Product Spec

Nov 19, 2026. Transcribed from the owner's PDF; that PDF is the source of truth.

## Overview

Tony is a personal AI agent that holds Behruzbek's tasks, watches them 24/7 and keeps reminding him until each one is started, done, moved or dropped. You talk to him in Telegram (text or voice); you see and manage everything in an installable web app (PWA).

v1 goals:

1. Capture anything in seconds: a Telegram text or voice note becomes a scheduled task.
2. Never let a task die silently: missed and untouched tasks come back with a polite reminder.
3. Persistent mode: for important tasks (a workout), Tony keeps nudging until Behruzbek taps Start or Skip.
4. A Todoist-grade app in Apple style, in Tony's colors.
5. Tony remembers habits and preferences and uses them in replies.

Not in v1: browsing websites, booking, shopping, sending email on his behalf, multiple users. These are listed under Later versions.

Single user (Behruzbek), English, timezone Asia/Tashkent (UTC+5).

## Personality

Tony is a Jarvis-style butler: calm, polite, dry wit, never preachy. He addresses Behruzbek as "sir", speaks English, and keeps messages short enough to read on a lock screen.

Tone rules:

- One to three short sentences per message. No walls of text.
- Polite but persistent: he never gives up on an important task, and never guilt-trips.
- Confirms every action in a few words ("Noted, sir. Workout at 18:00.").
- A light touch of wit is allowed; sarcasm and emoji spam are not. At most one emoji, rarely.
- When unsure (time, date, which task), he asks one short question instead of guessing.
- Changing or deleting tasks: he acts, then confirms. Deleting several tasks at once: he asks first.

System prompt (v1 draft, edit freely; Tony reads it before every reply):

```
You are Tony, the personal AI agent of Behruzbek, an English teacher and
content creator in Tashkent (Asia/Tashkent, UTC+5).

Character: a calm, polite, quietly witty butler in the style of Jarvis.
Address the user as "sir". Speak English.

Your job: capture his tasks, keep them organised, and make sure nothing he
planned is forgotten. You work through tools; never claim you did something
unless a tool call succeeded.

Style:
- Reply in 1-3 short sentences. Lock-screen length.
- Confirm each action briefly, with the exact time and date you set.
- If the time or task is ambiguous, ask one short question.
- Be persistent about important tasks but never guilt-trip. No lectures.
- At most one emoji, and only occasionally.

Rules:
- Today is {today}, current time {now}. Resolve relative dates ("tomorrow",
"Monday") against this.
- Use the memory notes below to personalise suggestions, but do not recite
them.
- Never invent tasks, times or facts.

Memory notes:
{memory}

Open tasks:
{task_summary}
```

## Example conversations

These samples are fed to the model as examples, so Tony copies their length and tone. Buttons are shown in [brackets].

1. Voice note capture
   - Behruzbek (voice): "Remind me to work out at 6 p.m."
   - Tony: "Noted, sir. Workout today at 18:00, persistent mode on."
2. Persistent reminder, no reply
   - 18:00 Tony: "Sir, it's time for your workout." [Starting now] [15 min] [Skip today]
   - 18:15 Tony: "A gentle reminder, sir. The workout is still waiting."
   - 18:30 Tony: "Sir, shall I move the workout to later this evening?" [Starting now] [Move to 20:00] [Skip today]
   - 19:00 Tony: "Still no workout logged, sir. I'll check again at 19:30."
   - Behruzbek taps [Starting now]. Tony: "Excellent. Enjoy it, sir."
3. Missed task from a past day
   - Tuesday 08:00 Tony: "Good morning, sir. One item from Monday remains open: prepare Unit 5 slides. Shall I put it on today?" [Today] [Tomorrow] [Drop]
4. Forgotten inbox item
   - Tony: "Sir, 'record a Reel about phrasal verbs' has sat in the inbox for 4 days. Shall I schedule it?" [Tomorrow] [This weekend] [Drop]
5. Morning brief (08:00)
   - Tony: "Good morning, sir. Today: 3 tasks. Classes 10:00, slides for Unit 5, workout 18:00. One item carried over from yesterday." [Open app]
6. Evening review (21:00)
   - Tony: "Evening, sir. Two tasks are still open: reading 20 pages, reply to the school. Move them to tomorrow?" [Move all] [Choose] [Leave them]
7. Ambiguous request
   - Behruzbek: "remind me about the meeting"
   - Tony: "Of course, sir. Which day and time is the meeting?"
8. Quick status
   - Behruzbek: "what's left today?"
   - Tony: "Two items, sir: Unit 5 slides and the workout at 18:00."

## v1 features

Eight features make up v1; everything else waits.

| Feature | What it does | Where |
|---|---|---|
| Capture | Any text or voice note to Tony becomes a task; with no date it goes to Inbox | Telegram, PWA |
| Voice notes | Telegram voice (.ogg) is transcribed to text, then handled like a typed message | Telegram |
| Tasks | Title, notes, due date and time, project, priority (P1 to P4), repeat (daily, weekdays, weekly), status | Both |
| Reminders | A one-time reminder at the due time, with Done / Snooze / Reschedule buttons | Telegram |
| Persistent mode | Repeats the reminder until Start, Done or Skip is tapped (schedule below) | Telegram |
| Missed and stale check | Overdue tasks come back the next morning; Inbox items untouched for 3 days get a nudge | Telegram |
| Briefs | Morning brief 08:00 and evening review 21:00, times editable in Settings | Telegram |
| Memory | Tony saves facts the user states ("I work out in the evenings") and uses them in replies, in three layers: this week, this month, always (see "Layered memory" below) | Both |

Persistent mode schedule (default, editable per task): 0, +15, +30, +60, +90, +120 minutes, then one last message: "I'll leave it here for today, sir." The task is then marked missed and enters the next morning's brief.

Quiet hours: no reminders between 23:00 and 07:00 unless a task is set inside that window.

Anti-spam: at most one non-persistent nudge per task per day, and at most 6 unprompted messages per hour in total.

## Persistent reminder flow

Tony keeps nudging until you tap Start, Done or Skip.

1. Due time arrives → send reminder.
2. Answered (Start, Done or Skip tapped)? Yes → stop reminders.
3. No → steps left? Yes → wait for the next step (+15, 30, 60, 90, 120 min) → send reminder again.
4. No steps left → mark as missed → into next morning's brief.

Button taps skip the AI, so stopping is instant; once the schedule runs out, the task goes into the next morning's brief.

## App screens and design

The PWA follows Todoist's structure with Apple-style finish: lots of white space, one accent color, soft depth, instant interactions. Mobile-first, installable to the home screen, light and dark themes.

| Screen | Contents |
|---|---|
| Today | Greeting + date, overdue section, today's tasks by time, quick-add bar at the bottom |
| Inbox | Undated tasks, oldest first, age badge on items older than 3 days |
| Upcoming | Next 7 days as a scrolling day list, drag a task to another day |
| Projects | Lists such as Teaching, Content, Health, Personal, with color dots |
| Task sheet | Bottom sheet: title, notes, date and time, priority, project, repeat, persistent toggle |
| Chat | The same conversation as Telegram, inside the app, with a mic button |
| Settings | Brief times, quiet hours, persistent schedule, Tony's memory (view and delete facts), Telegram link |

Navigation: bottom tab bar (Today, Inbox, Upcoming, Chat) with a floating + button; Projects and Settings open from the top-left avatar.

Design tokens:

| Token | Light | Dark |
|---|---|---|
| Primary (Tony Blue) | #5B8BFF | #5B8BFF |
| Accent (Electric Violet) | #7A5CFF | #7A5CFF |
| Ink / Graphite | #0F172A | #F1F5F9 |
| Background | #FFFFFF | #0F172A |
| Surface (cards, sheets) | #F6F7FB | #1E2638 |
| Secondary text | #64748B | #94A3B8 |
| Overdue | #FF5A5F | #FF6B6F |
| Done | #34C759 | #30D158 |

Type: SF Pro on Apple devices, Inter elsewhere. Sizes 34 large title, 22 section, 17 body, 15 secondary, 13 caption.

Shape and motion: 12 px corners on cards, 20 px on sheets, 8 px spacing grid, 44 px minimum tap target. Completing a task plays a short check animation and a light haptic. The blue-to-violet gradient appears only on Tony's avatar and the + button.

Icons: the dark logo version as the app icon; the white-on-gradient version as the Telegram bot avatar (it reads best inside a small circle).

## Architecture

Telegram and the app share one server, one brain, one database.

- **You:** Telegram (text, voice, buttons); Tony app (PWA: Today, Inbox, Chat).
- **Server (Next.js on Vercel):** bot webhook (receives Telegram messages) → Tony's brain (prompt, examples, 7 tools) ← app API (serves the app screens); reminder engine (sends nudges via Telegram).
- **Outside services:** speech-to-text (turns voice into text); AI model (free tier, swappable); Supabase database (tasks, reminders, memory); scheduler (ticks every minute).

Every message, tap and reminder passes through one server and one database, so Telegram and the app always show the same tasks.

## Data model and tools

Six tables hold everything; seven tools are all Tony can do.

| Table | Key columns |
|---|---|
| tasks | id, title, notes, project_id, priority, status (inbox, todo, in_progress, done, skipped, dropped), due_at, repeat_rule, persistent (bool), created_at, updated_at, completed_at |
| reminders | id, task_id, fire_at, kind (due, nudge, stale, brief), attempt, state (scheduled, sent, acknowledged, cancelled), telegram_message_id |
| projects | id, name, color, order |
| memory | id, fact, source (user), layer (week, month, always), goal (bool), mentions, confirmed_at, created_at |
| messages | id, role (user, tony), text, channel (telegram, app), created_at |
| settings | telegram_chat_id, timezone, brief_morning, brief_evening, quiet_start, quiet_end, persistent_schedule |

Tools the AI can call:

| Tool | Purpose |
|---|---|
| add_task | Create a task (title, due_at, project, priority, persistent) |
| update_task | Change any field, including reschedule |
| complete_task | Mark done; cancels pending reminders |
| list_tasks | Filter by day, status or project |
| set_reminder | Extra reminder at a time for a task |
| remember | Save a fact the user stated |
| forget | Delete a saved fact |

Button taps (Start, Done, Snooze, Skip, Move) bypass the AI and call the code directly, so they are instant and free.

## Build phases (Claude Code)

Claude Code builds Tony in eight phases; each ends with a check Behruzbek can do on his phone. Do not start a phase until the previous one passes.

Stack: Next.js (App Router, TypeScript) on Vercel; Supabase (Postgres + auth); grammY for the Telegram bot via webhook; a scheduler that calls the server every minute (Supabase cron); the AI model behind one swappable setting, starting on a free tier; a speech-to-text service for voice notes. Check current free-tier limits and prices before choosing the model and speech-to-text provider.

1. **Setup.** Create the bot in @BotFather, the Supabase project and the Vercel project; store keys in environment variables, never in code.
   Done when: the deployed site loads and the bot answers /ping with "pong".
2. **Tasks core, no AI.** Database tables, plain text to Tony becomes an Inbox task, /today and /inbox list tasks.
   Done when: sending "buy notebook" shows it in /inbox.
3. **Reminder engine.** Every-minute tick, reminders table, buttons (Done, Snooze, Skip), persistent schedule, quiet hours, anti-spam caps.
   Done when: a persistent test task set 2 minutes ahead nudges at the right times and stops on Start.
4. **Tony's brain.** System prompt, example conversations, the seven tools, natural dates ("Monday at 6") in Asia/Tashkent.
   Done when: "remind me to work out at 6 pm" creates the correct task and Tony confirms in his voice.
5. **Voice notes.** Download Telegram voice, transcribe, pass the text to the brain.
   Done when: the same workout request works as a voice note.
6. **The app.** PWA install, Today, Inbox, Upcoming, Projects, task sheet, Chat, Settings, light and dark themes, design tokens above.
   Done when: the app installs on the phone and a task created in Telegram appears there within seconds.
7. **Briefs, missed tasks, memory.** Repeating tasks roll forward to their next date after Done or Skip (added by the owner). Morning brief, evening review, overdue and 3-day stale checks, remember and forget, memory list in Settings.
   Done when: a task left undone yesterday appears in this morning's brief.
8. **Live week.** Use Tony for 7 days, log every annoying or missed reminder, tune the schedule and prompt.
   Done when: a full week passes with no missed reminders and no message Behruzbek wanted to mute.

The repo starts with a CLAUDE.md that links this spec and states: build one phase at a time, run it, show the result, then wait for approval.

### Layered memory (added by the owner, 22 Nov)

Memory is kept in three layers, in the database (migration `0026_memory_layers.sql`):

| Layer | Holds | Fades |
|---|---|---|
| This week | What is true now: this week's plans, focus and goals ("IELTS prep is my priority") | After 7 days without coming up |
| This month | What held for more than a week, and monthly goals | After 31 days without coming up |
| Always | Who he is, his people, preferences, routine, how he wants Tony to work | Never on its own |

- **Every reply checks memory first:** all live week and month notes, and the always notes that bear on the message, grouped by layer, goals marked 🎯. Faded notes are left out.
- **Saying it again confirms it:** the same note is counted and kept fresh (never copied), and can move up a layer, never down. A repeat gets no receipt; a new note does ("📝 This week: …").
- **Goals come first:** in the planner (goal tasks earliest in the day) and in the morning brief ("🎯 Focus: …" right under the greeting).
- **Sunday review, 21:30:** the model reads the week and month notes against what he said that week (his own words only). What held moves up a layer, what went stale is dropped, the rest is kept; always notes are never touched. Rails in code: a week note moves up only after 3 days, a month note after 3 weeks; nothing confirmed in the last day is dropped. If the model cannot be reached, plain rules decide. He gets a three-line summary (learned, moved up, dropped) with ↩ to keep what was dropped and 🧠 to open /memory. The review runs even in quiet hours; only the summary waits for the day's message budget.
- **/memory** shows the three layers (this week, this month, always), goals 🎯 and fading notes marked, each with 🗑. Settings in the app shows each note's layer.

## Later versions and open questions

Muse-style powers arrive after v1 runs reliably for a month.

| Version | Adds |
|---|---|
| v2 | Google Calendar sync (classes appear in the brief), weekly review on Sunday, habit streaks (workout, reading) |
| v3 | Gmail summaries and drafts, with approval before anything is sent |
| v4 | Web research and form filling, every action approved by tap first |

Open questions:

- [ ] Should Tony also understand Uzbek and Russian voice notes, while replying in English? (As built: the language is auto-detected, so he does.)
- [ ] Exact quiet hours: is 23:00 to 07:00 right?
- [x] Default projects: Teaching, Content, Health, Personal, or others? **Answered: keep these four.**
- [ ] App name on the home screen: "Tony"?
