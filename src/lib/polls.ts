import "server-only";
import type { Bot } from "grammy";
import { CONFIRMATION_HOURS, hoursFromNow, retire, sendTracked, track } from "./chat-log";
import { requireDb } from "./db";
import { b, esc, plain } from "./html";
import { logMessage } from "./messages";
import { scheduleReminder, settleReminders } from "./reminders";
import { placeAnytime } from "./slots";
import { OPEN_STATUSES, type Task } from "./tasks";
import { decideFor, timeOnDay } from "./routine";
import { DAY_TASK_LIMIT, dayLoads, soonestSlot } from "./smart-inbox";
import { addMinutes, dayBounds, formatDay, formatDue, formatTime, hisDate, hisTomorrow, localDate, minuteOfDay, parseLocalDateTime, TIMEZONE, toWholeMinute } from "./time";
import { dayView } from "./views";

/**
 * Telegram polls as a way to decide things with a tap or two. Each poll is
 * stored with what its options mean; when the vote arrives (poll_answer),
 * plain code carries it out. No AI model is involved.
 */
export type PollKind = "plan" | "missed" | "week";
type Option = { task?: number; at?: string; drop?: true; none?: true; mood?: string };
type StoredPoll = { poll_id: string; message_id: number; kind: PollKind; task_id: number | null; options: Option[]; closed_at: string | null; created_at?: string };

/** Telegram allows 12 options of up to 100 characters each. */
const MAX_OPTIONS = 12;
const clip = (text: string, max = 100) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const weekdayOf = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short" }).format(at);

async function sendPoll(
  bot: Bot,
  chatId: number,
  input: { question: string; labels: string[]; options: Option[]; kind: PollKind; taskId?: number; multiple?: boolean; silent?: boolean },
): Promise<number> {
  const message = await bot.api.sendPoll(
    chatId,
    clip(input.question, 300),
    input.labels.map((text) => ({ text: clip(text) })),
    // Not anonymous, or Telegram would not tell Tony what was chosen.
    { is_anonymous: false, allows_multiple_answers: input.multiple ?? false, disable_notification: input.silent },
  );
  const { error } = await requireDb().from("polls").insert({
    poll_id: message.poll.id,
    message_id: message.message_id,
    kind: input.kind,
    task_id: input.taskId ?? null,
    options: input.options,
  });
  if (error) throw new Error(`sendPoll: ${error.message}`);
  await logMessage("tony", `${input.question}\n${input.labels.map((label) => `○ ${label}`).join("\n")}`);
  return message.message_id;
}

/** Evening planning: "Which ones tomorrow?" over what is still open and what waits in the inbox. */
export async function sendPlanPoll(bot: Bot, chatId: number, tasks: Task[]): Promise<number | undefined> {
  const shown = tasks.slice(0, MAX_OPTIONS - 1);
  if (shown.length === 0) return undefined;
  const messageId = await sendPoll(bot, chatId, {
    question: "Which ones tomorrow, sir?",
    labels: [...shown.map((task) => task.title), "None of these"],
    options: [...shown.map((task) => ({ task: task.id })), { none: true }],
    kind: "plan",
    multiple: true,
  });
  // Tidied away with the next evening's review.
  await track(messageId, "brief:evening");
  return messageId;
}

/** A missed task: a few sensible new times to choose from, or drop it. */
export async function sendMissedPoll(bot: Bot, chatId: number, task: Task, now = new Date()): Promise<number> {
  const { start, end } = dayBounds(now);
  const usualMinute = task.due_at ? minuteOfDay(new Date(task.due_at)) : 9 * 60;
  const usualToday = new Date(start.getTime() + usualMinute * 60_000);
  const hour = 60 * 60_000;
  const nextHour = new Date(Math.ceil((now.getTime() + hour / 2) / hour) * hour);
  const evening = new Date(start.getTime() + 20 * hour);
  const tomorrow = addMinutes(usualToday, 24 * 60);
  let saturday = parseLocalDateTime(`${localDate(now)}T10:00`)!;
  for (let n = 0; n < 8 && (weekdayOf(saturday) !== "Sat" || saturday.getTime() <= now.getTime()); n++) saturday = addMinutes(saturday, 24 * 60);

  const times: Date[] = [];
  const add = (at: Date) => {
    if (at.getTime() > now.getTime() + 10 * 60_000 && !times.some((t) => Math.abs(t.getTime() - at.getTime()) < 30 * 60_000)) times.push(at);
  };
  if (usualToday.getTime() < end.getTime()) add(usualToday);
  if (nextHour.getTime() < end.getTime()) add(nextHour);
  add(evening);
  add(tomorrow);
  add(saturday);
  times.sort((x, y) => x.getTime() - y.getTime());

  const label = (at: Date) => {
    const text = formatDue(at, now); // "today 18:00", "tomorrow 09:00", "Sat 21 Nov 10:00"
    return text[0].toUpperCase() + text.slice(1).replace(/ (\d{1,2}:\d{2})$/, " at $1");
  };
  const messageId = await sendPoll(bot, chatId, {
    question: `"${clip(task.title, 200)}" is still open, sir. When shall it be?`,
    labels: [...times.map(label), "Drop it"],
    options: [...times.map((at) => ({ at: at.toISOString() })), { drop: true }],
    kind: "missed",
    taskId: task.id,
  });
  // Removed once the task is settled, like any other question about it.
  await track(messageId, "prompt", { taskId: task.id });
  return messageId;
}

export const WEEK_MOODS = ["On top of things", "About right", "Too much on my plate", "Too many reminders", "Too few reminders"];

/** Sunday's one-question review. */
export async function sendWeekPoll(bot: Bot, chatId: number): Promise<number> {
  const messageId = await sendPoll(bot, chatId, {
    question: "How did the week go, sir?",
    labels: WEEK_MOODS,
    options: WEEK_MOODS.map((mood) => ({ mood })),
    kind: "week",
    silent: true,
  });
  await track(messageId, "brief:evening");
  return messageId;
}

/** A vote has arrived. Carries it out and confirms. */
export async function handlePollAnswer(bot: Bot, chatId: number, pollId: string, chosen: number[], now = new Date()): Promise<void> {
  const db = requireDb();
  const found = await db.from("polls").select().eq("poll_id", pollId).maybeSingle();
  if (found.error) throw new Error(`handlePollAnswer: ${found.error.message}`);
  const poll = found.data as StoredPoll | null;
  // Not one of Tony's, already acted on, or the vote was withdrawn.
  if (!poll || poll.closed_at || chosen.length === 0) return;

  const picks = chosen.map((index) => poll.options[index]).filter(Boolean);
  const close = async () => {
    const { error } = await db.from("polls").update({ closed_at: now.toISOString() }).eq("poll_id", pollId);
    if (error) console.error(`handlePollAnswer: ${error.message}`);
    // Freeze the poll so a later tap cannot act a second time.
    await bot.api.stopPoll(chatId, Number(poll.message_id)).catch(() => undefined);
  };
  const confirm = async (html: string, taskId?: number) => {
    await sendTracked(bot, chatId, html, { kind: "confirmation", taskId, deleteAfter: hoursFromNow(CONFIRMATION_HOURS, now) });
    await logMessage("tony", plain(html));
  };

  if (poll.kind === "plan") {
    const ids = picks.map((pick) => pick.task).filter((id): id is number => id !== undefined);
    // The day the poll asked about: the evening's "tomorrow", even when he votes after midnight (23 Nov 04:12:
    // the vote put the tasks on Monday and then showed Tuesday, "11 tasks set" when three had moved).
    const asked = poll.created_at ? new Date(poll.created_at) : now;
    const target = [localDate(hisTomorrow(asked)), hisDate(now)].sort().at(-1)!;
    const placed: { title: string; at: Date; later: boolean; untimed?: boolean }[] = [];
    const unplaced: string[] = [];
    for (const id of ids) {
      const { data } = await db.from("tasks").select().eq("id", id).maybeSingle();
      const task = data as Task | null;
      if (!task || !OPEN_STATUSES.includes(task.status)) continue;
      const at = await placeOn(task, target, now);
      if (!at) {
        unplaced.push(task.title);
        continue;
      }
      // A task he never gave a time keeps none (23 Nov 05:52: "everything has a time, even the ones I did not
      // add"): it goes on the day as "no time", with one reminder at 20:00.
      const untimed = !task.due_at || task.anytime === true;
      if (untimed) {
        const set = await placeAnytime(task.id, localDate(at), now);
        if (set?.due_at) placed.push({ title: task.title, at: new Date(set.due_at), later: localDate(at) !== target, untimed: true });
        continue;
      }
      const { error } = await db.from("tasks").update({ due_at: at.toISOString(), status: "todo", free_time: false }).eq("id", task.id);
      if (error) throw new Error(`handlePollAnswer: ${error.message}`);
      await scheduleReminder(task.id, at);
      placed.push({ title: task.title, at, later: localDate(at) !== target });
    }
    await close();
    if (placed.length === 0 && unplaced.length === 0) {
      await confirm("Very good, sir. Nothing moved.");
      return;
    }
    // Only what really moved is counted; what went to a later day (the day was full) says where.
    const day = parseLocalDateTime(`${target}T12:00`)!;
    const onDay = placed.filter((item) => !item.later).length;
    const later = placed.filter((item) => item.later);
    const lead = [
      ...(onDay ? [`Very good, sir. ${onDay === 1 ? "One task" : `${onDay} tasks`} set for ${formatDay(day, now)}.`] : []),
      ...(later.length ? [`${onDay ? "" : "Very good, sir. "}${formatDay(day, now)} is full, so ${later.length === 1 ? "one goes" : onDay ? `${later.length} go` : "they go"} to the next free day:`, ...later.map((item) => `• ${item.title} → ${formatDay(item.at, now)}${item.untimed ? ", no time" : ` ${formatTime(item.at)}`}`)] : []),
      ...(unplaced.length ? [`No free time in the next two weeks for: ${unplaced.join(", ")}. They stay in the inbox.`] : []),
    ].join("\n");
    const view = await dayView(day, now, { lead });
    // One plan at a time: the new one replaces the old.
    await retire({ kinds: ["plan"] }, now);
    await sendTracked(bot, chatId, view.html, { keyboard: view.keyboard, kind: "plan" });
    await logMessage("tony", plain(view.html));
    return;
  }

  if (poll.kind === "missed") {
    const pick = picks[0];
    const { data } = poll.task_id === null ? { data: null } : await db.from("tasks").select().eq("id", poll.task_id).maybeSingle();
    const task = data as Task | null;
    await close();
    if (!task || !OPEN_STATUSES.includes(task.status)) return;
    if (pick.drop) {
      const { error } = await db.from("tasks").update({ status: "dropped" }).eq("id", task.id);
      if (error) throw new Error(`handlePollAnswer: ${error.message}`);
      await settleReminders(task.id);
      await confirm(`Dropped, sir. ${b(task.title)} is off the list.`, task.id);
      return;
    }
    if (!pick.at) return;
    let at = toWholeMinute(new Date(pick.at));
    // A vote cast long after the poll went out may name a time now past.
    if (at.getTime() <= now.getTime()) at = toWholeMinute(addMinutes(now, 15));
    const { error } = await db.from("tasks").update({ due_at: at.toISOString(), status: "todo" }).eq("id", task.id);
    if (error) throw new Error(`handlePollAnswer: ${error.message}`);
    await scheduleReminder(task.id, at);
    await confirm(`Done, sir. ${b(task.title)} is set for ${b(formatDue(at, now).replace(/ (\d{1,2}:\d{2})$/, " at $1"))}.`, task.id);
    return;
  }

  if (poll.kind === "week") {
    const mood = picks[0]?.mood;
    await close();
    if (!mood) return;
    // Kept as a this-week memory note, so Tony can take it into account next week; it fades after that.
    const week = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, day: "numeric", month: "short" }).format(now);
    const { error } = await db.from("memory").insert({ fact: `Week ending ${week}: he said it went "${mood}"`, source: "user", layer: "week", confirmed_at: now.toISOString() });
    if (error) console.error(`handlePollAnswer: ${error.message}`);
    const reply =
      mood === "Too much on my plate"
        ? "Noted, sir. I shall suggest a lighter load when the days fill up."
        : mood.includes("reminders")
          ? "Noted, sir. The schedule is yours to adjust in Settings, and I shall bear it in mind."
          : "Noted, sir. Here's to the next one.";
    await confirm(esc(reply));
  }
}

/**
 * Where a task he ticked for a day goes: that day at its own time (or the best free time, if it has
 * none) while the day has room; otherwise the first later day with room (the smart inbox, Phase I).
 */
async function placeOn(task: Task, date: string, now: Date): Promise<Date | undefined> {
  const loads = await dayLoads(date, 1, task.id);
  const day = parseLocalDateTime(`${date}T12:00`)!;
  if ((loads.get(date) ?? 0) < DAY_TASK_LIMIT) {
    const own = task.due_at ? (await timeOnDay(task, day, now))?.at : undefined;
    if (own && own.getTime() > now.getTime()) return own;
    const decision = await decideFor(task, day, now);
    const best = decision.decision === "ask" || decision.decision === "auto" ? decision.options.find((option) => option.at.getTime() > now.getTime()) : undefined;
    if (best) return best.at;
  }
  const later = await soonestSlot(task, now, { after: date });
  if (!later) return undefined;
  // A task with its own time keeps that time of day on the later day, when it is free there.
  const own = task.due_at ? (await timeOnDay(task, parseLocalDateTime(`${later.day}T12:00`)!, now))?.at : undefined;
  return own && localDate(own) === later.day ? own : later.options[0]?.at;
}
