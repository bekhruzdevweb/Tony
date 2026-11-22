/**
 * Small, pure rules that keep Tony honest. No database, no model: each is
 * covered by a regression test in tests/brain-checks.test.ts.
 */
import { formatDay, formatTime, formatWhen, parseLocalDateTime } from "../time";

export type ReminderDecision = "move" | "same" | "extra";

/**
 * "Remind me about X at T" for a task that already exists:
 * - after its time (or it has no time): the task itself moves to T (a reschedule);
 * - at its time: nothing to add, its reminder is already there;
 * - before its time: an extra heads-up at T, the task stays where it is.
 * (17:31, 20 Nov: "barber at 8:30" for a task at 07:00 added a heads-up and
 * left the task at 07:00. Now it moves the task.)
 */
export function decideReminder(due: Date | null | undefined, at: Date): ReminderDecision {
  if (!due) return "move";
  const delta = at.getTime() - due.getTime();
  if (Math.abs(delta) < 60_000) return "same";
  return delta > 0 ? "move" : "extra";
}

/** True when a reminder for this task at this minute is already waiting (no duplicates). */
export function isDuplicateReminder(waiting: { fire_at: string }[], at: Date): boolean {
  return waiting.some((row) => Math.abs(new Date(row.fire_at).getTime() - at.getTime()) < 60_000);
}

/** One change Tony made, as read back from the database after the change. */
export type DoneAction = {
  tool: "add_task" | "update_task" | "complete_task" | "set_reminder" | "subtask";
  title: string;
  /** Its title before this change, when he renamed it. */
  renamedFrom?: string;
  /** With a rename: whether its time changed too (else the time is not repeated). */
  dueChanged?: boolean;
  /** How it repeats, and until when (YYYY-MM-DD), shown as "🔁 weekly until Sun 17 Jan". */
  repeat?: string | null;
  repeat_until?: string | null;
  /** The task's stored state after the change. */
  status: string;
  due_at: string | null;
  /** For a heads-up reminder: when it fires. */
  reminder_at?: string;
  /** Its parts' progress, "2/3", when it has subtasks. */
  parts?: string;
  /** The task holds a link in its notes. */
  link?: boolean;
  /** Photos, videos and files attached to the task. */
  media?: { photo: number; video: number; file: number };
  /** On the 🌙 Free Time list. */
  free_time?: boolean | null;
  /** Words saved in its notes this time (shown short). */
  note?: string;
  /** A check-in comes after this many untouched days. */
  checkIn?: number;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 photo, 1 video" for a task's attachments, as Tony's own list shows them; undefined when none. */
export function attachedText(media?: { photo: number; video: number; file: number }): string | undefined {
  if (!media) return undefined;
  const parts = [
    media.photo ? count(media.photo, "photo", "photos") : undefined,
    media.video ? count(media.video, "video", "videos") : undefined,
    media.file ? count(media.file, "file", "files") : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** What the task holds, on its receipt: " · 0/3 parts · 🔗 link · 🖼 1 photo · 📝 For the student from New York · 🔔 check-in after 2 untouched days". */
export function savedMarks(action: Pick<DoneAction, "parts" | "link" | "media" | "note" | "checkIn">, withParts = true): string {
  const note = action.note?.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return [
    withParts && action.parts ? `${action.parts} parts` : undefined,
    action.link ? "🔗 link" : undefined,
    action.media?.photo ? `🖼 ${count(action.media.photo, "photo", "photos")}` : undefined,
    action.media?.video ? `🎞 ${count(action.media.video, "video", "videos")}` : undefined,
    action.media?.file ? `📎 ${count(action.media.file, "file", "files")}` : undefined,
    note ? `📝 ${note.length > 60 ? `${note.slice(0, 57)}…` : note}` : undefined,
    action.checkIn ? `🔔 check-in after ${action.checkIn} untouched ${action.checkIn === 1 ? "day" : "days"}` : undefined,
  ]
    .filter(Boolean)
    .map((mark) => ` · ${mark}`)
    .join("");
}

/**
 * The confirmation, built from what is really stored, never from what the
 * model said it would do. One line per change, so a message with several
 * requests gets each one listed.
 */
export function confirmationFor(actions: DoneAction[], now: Date, said?: string): string {
  const line = (action: DoneAction) => `${baseLine(action)}${savedMarks(action, action.tool !== "subtask")}`;
  const baseLine = (action: DoneAction) => {
    const title = `**${action.title}**`;
    if (action.tool === "complete_task" || action.status === "done") return `✓ ${title} done`;
    if (action.status === "dropped") return `✓ ${title} removed`;
    if (action.status === "skipped") return `✓ ${title} skipped`;
    if (action.tool === "subtask" && action.parts) return `☑ ${title}: ${action.parts} parts done`;
    // "Change this title to …": the old name and the new one; the time only if that changed too.
    if (action.renamedFrom && !action.dueChanged && !action.reminder_at) return `✏️ ~~${action.renamedFrom}~~ → ${title}`;
    // Every time named with its weekday and date ("tomorrow, Sat 21 Nov, 08:30"), the clock time in bold.
    const bold = (at: Date) => formatWhen(at, now, undefined, said).replace(/(\d{2}:\d{2})$/, "**$1**");
    if (action.reminder_at) {
      return `🔔 ${title}: reminder ${bold(new Date(action.reminder_at))}${action.due_at ? ` (task at **${formatTime(new Date(action.due_at))}**)` : ""}`;
    }
    if (!action.due_at) return action.free_time ? `✓ ${title} → 🌙 Free Time` : `✓ ${title} in the inbox`;
    const until = action.repeat_until ? parseLocalDateTime(`${action.repeat_until}T12:00`) : undefined;
    const repeats = action.repeat ? ` · 🔁 ${action.repeat}${until ? ` until ${formatDay(until, now)}` : ""}` : "";
    return `✓ ${title} → ${bold(new Date(action.due_at))}${repeats}`;
  };
  const unique = actions.filter((action, index) => actions.findIndex((other) => other.title === action.title && other.tool === action.tool && other.reminder_at === action.reminder_at) === index);
  // One small receipt line per task, under Tony's own words (Phase 2): no "sir", no "Done, sir:" header.
  return unique.map(line).join("\n");
}

export type TimedTask = { id: number; title: string; due_at: string | null; duration_minutes?: number | null; kind?: string | null; status: string };

const OPEN = new Set(["inbox", "todo", "in_progress"]);
const CLASH_MINUTES = 30;

/**
 * Tasks that clash with `task`: open, timed, not prayers, starting within
 * 30 minutes of it, or overlapping it when either has a known duration.
 */
export function clashesWith(task: TimedTask, others: TimedTask[]): TimedTask[] {
  if (!task.due_at || task.kind === "prayer") return [];
  const start = new Date(task.due_at).getTime();
  const end = start + (task.duration_minutes ?? 0) * 60_000;
  return others.filter((other) => {
    if (other.id === task.id || !other.due_at || other.kind === "prayer" || !OPEN.has(other.status)) return false;
    const otherStart = new Date(other.due_at).getTime();
    const otherEnd = otherStart + (other.duration_minutes ?? 0) * 60_000;
    const near = Math.abs(otherStart - start) < CLASH_MINUTES * 60_000;
    const overlap = (task.duration_minutes || other.duration_minutes) ? otherStart < Math.max(end, start + 60_000) && start < Math.max(otherEnd, otherStart + 60_000) : false;
    return near || overlap;
  });
}

/** Every clashing pair on the list, each pair once (for the morning brief and /plan). */
export function allClashes(tasks: TimedTask[]): [TimedTask, TimedTask][] {
  const pairs: [TimedTask, TimedTask][] = [];
  const timed = tasks.filter((task) => task.due_at && task.kind !== "prayer" && OPEN.has(task.status)).sort((a, b) => a.due_at!.localeCompare(b.due_at!));
  timed.forEach((task, index) => {
    for (const other of clashesWith(task, timed.slice(index + 1))) pairs.push([task, other]);
  });
  return pairs;
}

/** The first whole hour after `task`'s time where it would clash with nothing, before `latest`. */
export function nextFreeSlot(task: TimedTask, others: TimedTask[], latest: Date): Date | undefined {
  if (!task.due_at) return undefined;
  for (let hours = 1; hours <= 12; hours++) {
    const at = new Date(new Date(task.due_at).getTime() + hours * 60 * 60_000);
    if (at.getTime() > latest.getTime()) return undefined;
    if (clashesWith({ ...task, due_at: at.toISOString() }, others).length === 0) return at;
  }
  return undefined;
}

/** At most this many clash lines in the morning brief; the rest are counted. */
export const MAX_CLASH_LINES = 3;

/**
 * The clashes as groups: tasks that clash with one another, directly or
 * through a third, are one group. Three tasks at 20:15 are one line, not
 * three pairs (22 Nov: six clash lines in the brief).
 */
export function clashGroups(tasks: TimedTask[]): TimedTask[][] {
  const group = new Map<number, number>();
  const find = (id: number): number => {
    const parent = group.get(id) ?? id;
    if (parent === id) return id;
    const root = find(parent);
    group.set(id, root);
    return root;
  };
  const byId = new Map<number, TimedTask>();
  for (const [a, c] of allClashes(tasks)) {
    byId.set(a.id, a);
    byId.set(c.id, c);
    const [ra, rc] = [find(a.id), find(c.id)];
    if (ra !== rc) group.set(rc, ra);
  }
  const groups = new Map<number, TimedTask[]>();
  for (const task of byId.values()) groups.set(find(task.id), [...(groups.get(find(task.id)) ?? []), task]);
  return [...groups.values()]
    .map((members) => members.sort((x, y) => x.due_at!.localeCompare(y.due_at!) || x.id - y.id))
    .sort((x, y) => x[0].due_at!.localeCompare(y[0].due_at!));
}

const andList = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** One group's line: "Posting stories, Reel and IELTS kickoff are all at 20:15" / "Workout (18:00) and Reading (18:20) overlap". */
export function clashGroupSentence(members: TimedTask[]): string {
  if (members.length === 2) return clashSentence(members[0], members[1]);
  const times = new Set(members.map((task) => formatTime(new Date(task.due_at!))));
  if (times.size === 1) return `${andList(members.map((task) => task.title))} are all at ${[...times][0]}`;
  return `${andList(members.map((task) => `${task.title} (${formatTime(new Date(task.due_at!))})`))} overlap`;
}

/** The brief's clash lines: one per group, at most MAX_CLASH_LINES, then how many more. */
export function clashLinesFor(tasks: TimedTask[]): string[] {
  const groups = clashGroups(tasks);
  const lines = groups.slice(0, MAX_CLASH_LINES).map((members) => `Clash: ${clashGroupSentence(members)}`);
  if (groups.length > MAX_CLASH_LINES) lines.push(`…and ${groups.length - MAX_CLASH_LINES} more clash${groups.length - MAX_CLASH_LINES === 1 ? "" : "es"} later today`);
  return lines;
}

/** "Workout and Reading are both at 18:00" / "Workout (18:00) and Reading (18:20) overlap". */
export function clashSentence(a: TimedTask, b: TimedTask): string {
  const ta = formatTime(new Date(a.due_at!));
  const tb = formatTime(new Date(b.due_at!));
  return ta === tb ? `${a.title} and ${b.title} are both at ${ta}` : `${a.title} (${ta}) and ${b.title} (${tb}) overlap`;
}

/**
 * "Remind this one after 20 minutes": with no reply to a message, "this one"
 * means the reminder Tony sent most recently, if it was in the last 15
 * minutes. Returns the note for the model, naming the task.
 */
export function recentReminderNote(sent: Touch[], now: Date): string | undefined {
  const recent = sent
    .filter((row) => row.task_id !== null && now.getTime() - new Date(row.sent_at).getTime() <= 15 * 60_000)
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const latest = recent[0];
  if (!latest) return undefined;
  const at = formatTime(new Date(latest.sent_at));
  const what =
    latest.how === "started"
      ? `He started task #${latest.task_id} "${latest.title}" at ${at} with your button`
      : latest.how === "done"
        ? `He ticked off task #${latest.task_id} "${latest.title}" at ${at} with your button`
        : latest.how === "moved"
          ? `He moved task #${latest.task_id} "${latest.title}" at ${at} with your button`
          : `You reminded him about task #${latest.task_id} "${latest.title}" at ${at}`;
  // The newest touch wins over an older reminder (22 Nov 12:14: he started the Freya's Talking posts
  // from Tony's question, said "I need to reschedule this task for tomorrow", and the 12:00 reminder
  // for "Watch saved video" was moved instead).
  const older = recent.find((row) => row.task_id !== latest.task_id);
  const notThat = older ? ` Your ${formatTime(new Date(older.sent_at))} message about #${older.task_id} "${older.title}" came before that: it is not the one.` : "";
  return `${what}: that is the task in focus. If he says "this task", "this one", "it" or "that" and his message names no other task and asks for no new one, he means #${latest.task_id}.${notThat} When his message also asks for something new ("put it in the inbox, remind me to study…"), "it" is that new thing.`;
}

/** Something that just happened to one task: Tony reminded him of it, or he tapped one of its buttons. */
export type Touch = { task_id: number | null; title: string; sent_at: string; how?: "reminded" | "started" | "done" | "moved" };

/** The newest message, marked so it is never mistaken for an earlier one. */
export function latestMessage(text: string, note?: string): string {
  return `[His latest message: handle every request in it, each with its own tool call, and nothing from earlier messages.]\n${text}${note ? `\n\n[${note}]` : ""}`;
}

/**
 * Which model a turn needs. Several requests in one message, or moving and
 * planning things, are multi-step: the larger model. A simple reply: the fast one.
 */
export function needsDeepModel(text: string): boolean {
  const words = text.toLowerCase();
  const times = (words.match(/\b\d{1,2}([:.]\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\b|\b(in|after) (half an hour|an hour|a few minutes|\d+ ?(min|mins|minutes|hours?))\b/g) ?? []).length;
  const joined = /\b(and also|also|and then|as well|plus)\b/.test(words);
  const moving = /\b(reschedul|move|postpone|push|shift|plan|organi[sz]e|swap|clash)/.test(words);
  return times >= 2 || (joined && times >= 1) || moving || words.length > 160;
}

/** A link in his words, or failing that in the last thing he shared. */
export function findLink(text: string, lastShared?: string | null): string | undefined {
  const pattern = /https?:\/\/[^\s<>"')\]]+/i;
  const strip = (url: string) => url.replace(/[).,!?]+$/, "");
  const own = pattern.exec(text)?.[0];
  if (own) return strip(own);
  const shared = lastShared ? pattern.exec(lastShared)?.[0] : undefined;
  return shared ? strip(shared) : undefined;
}

/** "Save this", "save it with the link", "bookmark that". */
export function asksToSave(text: string): boolean {
  return /\b(save|bookmark|keep)\b[^.?!]{0,40}\b(this|it|that|link|post|video|reel|article|page)\b/i.test(text) || /^\s*(save|bookmark)\b/i.test(text);
}

/** A page's title from its HTML (og:title first), or a readable stand-in from the address. */
export function titleFrom(html: string, url: string): string {
  const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html)?.[1];
  const title = og ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  const clean = title ? decode(title) : "";
  // A bare site name ("Instagram") says nothing about the page.
  if (clean && !/^(instagram|youtube|facebook|tiktok|x|twitter|telegram)$/i.test(clean)) return clean.slice(0, 120);
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const kind = /instagram\.com\/reel/.test(url) ? "Instagram reel" : /instagram\.com\/p\//.test(url) ? "Instagram post" : /youtu\.?be/.test(host) ? "YouTube video" : /t\.me/.test(host) ? "Telegram post" : host;
    return clean && kind === host ? `${clean} (${host})` : kind;
  } catch {
    return clean || url;
  }
}

/** When /plan is asked for "today": after 20:00, or with under two free hours left, it plans tomorrow. */
export const LATE_LEAD = "Today is nearly over, sir — here's tomorrow.";
export function planDay(now: Date, freeMinutesLeft: number): "today" | "tomorrow" {
  const local = new Date(now.getTime() + 5 * 60 * 60_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minute >= 20 * 60 || freeMinutesLeft < 120 ? "tomorrow" : "today";
}

/** Free at `at`: no open, timed, non-prayer task within 30 minutes (or overlapping by duration). */
export function isFreeAt(at: Date, tasks: TimedTask[], exceptId = -1): boolean {
  return clashesWith({ id: exceptId, title: "", due_at: at.toISOString(), status: "todo" }, tasks).length === 0;
}

/** Whether his words give a day or a time ("at 6", "tomorrow", "in 20 minutes", "on Monday"). */
export function givesTime(text: string): boolean {
  return /\b\d{1,2}([:.]\d{2})\s*(am|pm|a\.m\.|p\.m\.)?|\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)|\bat \d{1,2}\b|\b(today|tonight|tomorrow|morning|evening|afternoon|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)\b|\b(in|after) (half an hour|an hour|\d+ ?(min|mins|minutes|hours?))\b/i.test(text);
}

/** A saved link or note: titled "Read: …", or its description is just a link. */
export function isLinkTask(title: string, notes: string | null | undefined): boolean {
  return /^read:/i.test(title.trim()) || /^https?:\/\/\S+$/i.test((notes ?? "").trim());
}

/**
 * The ask tool's options, without any that name a time that is not free:
 * "Today 18:00" is dropped if something is already at 18:00 today.
 */
export function freeOptions(options: string[], tasks: TimedTask[], now: Date): string[] {
  const today = new Date(now.getTime() + 5 * 60 * 60_000).toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 29 * 60 * 60_000).toISOString().slice(0, 10);
  return options.filter((option) => {
    const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(option);
    if (!time) return true;
    const day = /tomorrow/i.test(option) ? tomorrow : /today|tonight/i.test(option) || !/\b(mon|tue|wed|thu|fri|sat|sun)/i.test(option) ? today : undefined;
    if (!day) return true;
    const at = new Date(`${day}T${time[1].padStart(2, "0")}:${time[2]}:00+05:00`);
    return isFreeAt(at, tasks);
  });
}

/** Overdue: open, timed, past its time, not started, not a prayer. One rule for every list. */
export function isOverdue(task: { status: string; due_at: string | null; kind?: string | null }, now: Date): boolean {
  return (task.status === "todo" || task.status === "inbox") && task.due_at !== null && task.kind !== "prayer" && new Date(task.due_at).getTime() < now.getTime();
}

/** "Clean the chat", "clear the chat", "tidy up the chat". */
export function asksToClean(text: string): boolean {
  return /\b(clean|clear|tidy|wipe|sweep)\b(\s+up)?\s+(the\s+|my\s+|this\s+)?(chat|messages|conversation)\b/i.test(text);
}

/** A reply that claims something was sent ("here it is", "attached"): only true after Telegram confirmed it. */
export function claimsSent(reply: string): boolean {
  return /\b(here (it is|is|'s|you go|they are)|attached|i('ve| have) sent|sending (it|you))\b/i.test(reply);
}
