import "server-only";
import { InlineKeyboard } from "grammy";
import { requireDb } from "./db";
import { doneKeyboard, rescheduleKeyboard, type Action } from "./reminder-messages";
import { scheduleReminder, settleReminders } from "./reminders";
import { ANYTIME_HOUR, OPEN_STATUSES, type Task } from "./tasks";
import { b } from "./html";
import { finishTask } from "./recurrence";
import { addMinutes, formatTime, formatWhen, hisTomorrow, localDate, parseLocalDateTime, TIMEZONE, toWholeMinute } from "./time";
import { choicesFor, decideFor, recordSample, timeOnDay } from "./routine";
import { habitFor, isHabit, streakLine } from "./habits";
import { autoReceipt, dayLabel, slotButtons, slotQuestion, splitQuestion, type Button } from "./slot-text";
import { markdownToHtml } from "./rich";
import { savedMarks } from "./brain/checks";

const weekdayOf = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short" }).format(at);

/** Buttons from slot-text, as a Telegram keyboard. */
export function keyboardOf(rows: Button[][]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  rows.forEach((row, index) => {
    if (index > 0) keyboard.row();
    // "url:<address>" is a link button (a reel to watch), every other button calls back.
    for (const button of row) {
      if (button.data.startsWith("url:")) keyboard.url(button.text, button.data.slice(4));
      else keyboard.text(button.text, button.data);
    }
  });
  return keyboard;
}

/**
 * A day button on a task with no time of its own: never a silent pick
 * (Change 1). He gets the question with the free slots, best first; only a
 * kind he said "decide yourself" for is placed, and the receipt says so.
 */
async function askOnDay(task: Task, day: Date, now: Date): Promise<ActionOutcome> {
  const dayKey = localDate(day);
  const label = dayLabel(dayKey, now);
  const decision = await decideFor(task, parseLocalDateTime(`${dayKey}T12:00`)!, now);
  const marks = savedMarks({ ...(/https?:\/\//.test(task.notes ?? "") ? { link: true } : {}) });
  if (decision.decision === "none") return { text: `${esc(label.plain.replace(/,$/, ""))} is full, sir; ${b(task.title)} stays where it is.`, keyboard: null };
  if (decision.decision === "auto") {
    await updateTask(task.id, { due_at: decision.at.toISOString(), status: "todo" });
    await scheduleReminder(task.id, decision.at);
    const text = autoReceipt({ title: task.title, marks, when: formatWhen(decision.at, now).replace(/(\d{2}:\d{2})$/, "**$1**"), why: decision.why });
    return { text: markdownToHtml(text), keyboard: keyboardOf(slotButtons({ kind: "auto", taskId: task.id, day: dayKey })) };
  }
  if (decision.decision === "split") {
    const text = splitQuestion({ title: task.title, marks, when: label.when, minutes: decision.minutes, total: task.duration_minutes ?? decision.minutes * 2, parts: decision.parts });
    return { text: markdownToHtml(text), keyboard: keyboardOf(slotButtons({ kind: "split", taskId: task.id, day: dayKey, parts: decision.parts })), waiting: true };
  }
  const text = slotQuestion({ title: task.title, marks, when: label.when, options: decision.options, taken: decision.taken });
  return { text: markdownToHtml(text), keyboard: keyboardOf(slotButtons({ kind: "ask", taskId: task.id, day: dayKey, options: decision.options })), waiting: true };
}

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** [📌 Fixed slot] or [📅 Schedule]: the slot question for that day, whatever time the task had before. */
export async function askForSlot(task: Task, day: Date, now = new Date()): Promise<ActionOutcome> {
  return askOnDay(task, day, now);
}

export type ActionOutcome = {
  /** What Tony says back, as Telegram HTML; nothing when the tap only changes the buttons. */
  text?: string;
  /** New buttons for the tapped message; null removes them. */
  keyboard: InlineKeyboard | null;
  /** A question still waiting for his answer (the free slots on a day): kept in the chat until he answers it. */
  waiting?: boolean;
};

/** The best free time on a day for a task with no time of its own: the first of the slots Tony would offer. */
async function bestOn(task: Task, day: Date, now: Date): Promise<{ at: Date } | undefined> {
  const options = await choicesFor(task, parseLocalDateTime(`${localDate(day)}T12:00`)!, now);
  const first = options.find((option) => option.at.getTime() > now.getTime());
  return first ? { at: first.at } : undefined;
}

/**
 * A move between the app's lanes (Phase H): Today, This week, Someday. Plain
 * code: a task with its own time keeps its time of day where that is free;
 * one without gets Tony's best free time, since the app has no question to ask.
 */
export async function moveToLane(taskId: number, lane: "today" | "week" | "someday", now = new Date()): Promise<string> {
  const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
  const task = found.data as Task | null;
  if (!task) return "That task is gone, sir.";
  if (!OPEN_STATUSES.includes(task.status)) return `${task.title} is already settled, sir.`;
  if (lane === "today" && !task.due_at) {
    const slot = await bestOn(task, now, now);
    if (!slot) return "Today is full, sir.";
    await updateTask(task.id, { due_at: slot.at.toISOString(), status: "todo", free_time: false });
    await scheduleReminder(task.id, slot.at);
    return `✓ ${task.title} → ${formatWhen(slot.at, now)}`;
  }
  const outcome = await runAction(lane, task.id, undefined, now);
  return (outcome.text ?? "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function updateTask(id: number, patch: Partial<Task>): Promise<void> {
  const { error } = await requireDb().from("tasks").update(patch).eq("id", id);
  if (error) throw new Error(`updateTask: ${error.message}`);
}

/** A button tap. Plain code, no AI model. */
export async function runAction(action: Action, taskId: number, arg: number | undefined, now = new Date()): Promise<ActionOutcome> {
  const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
  if (found.error) throw new Error(`runAction: ${found.error.message}`);
  const task = found.data as Task | null;
  if (!task) return { text: "That task no longer exists, sir.", keyboard: null };
  if (!OPEN_STATUSES.includes(task.status)) {
    return { text: `${b(task.title)} is already settled, sir.`, keyboard: null };
  }

  switch (action) {
    case "start":
      await updateTask(task.id, { status: "in_progress" });
      await settleReminders(task.id);
      return { text: "Excellent. Enjoy it, sir.", keyboard: doneKeyboard(task.id) };

    case "done": {
      const { nextLabel } = await finishTask(task, "done", now);
      if (task.kind === "prayer") return { text: "✓ Prayed.", keyboard: null };
      // A habit: its run, from the log, after this tick ("🔥 4 days in a row").
      const habit = isHabit(task) ? await habitFor(task.id, now) : undefined;
      const run = habit ? ` ${esc(streakLine(habit))}.` : "";
      return {
        text: nextLabel ? `✓ Done, sir.${run} ${b(task.title)} comes round again ${b(nextLabel)}.` : `✓ Done, sir.${run} ${b(task.title)} is off the list.`,
        keyboard: null,
      };
    }

    // "This week" (a lane in the app, Phase H): the first day from tomorrow with a free time for it.
    case "week": {
      for (let offset = 1; offset <= 6; offset++) {
        const day = addMinutes(hisTomorrow(now), (offset - 1) * 24 * 60);
        const slot = task.due_at ? await timeOnDay(task, day, now) : await bestOn(task, day, now);
        if (!slot) continue;
        await updateTask(task.id, { due_at: slot.at.toISOString(), status: "todo", free_time: false });
        await scheduleReminder(task.id, slot.at);
        return { text: `✓ ${b(task.title)} → ${b(formatWhen(slot.at, now))}`, keyboard: null };
      }
      return { text: `The week is full, sir; ${b(task.title)} stays where it is.`, keyboard: null };
    }

    // "Someday": the 🌙 Free Time list, no date, no reminders.
    case "someday": {
      await updateTask(task.id, { due_at: null, status: "inbox", free_time: true });
      await settleReminders(task.id);
      return { text: `🌙 ${b(task.title)} is on your Free Time list: no date, no reminders.`, keyboard: null };
    }

    case "skip": {
      const { nextLabel } = await finishTask(task, "skipped", now);
      return { text: nextLabel ? `Skipped, sir. Next one ${b(nextLabel)}.` : "Skipped for today, sir.", keyboard: null };
    }

    case "drop":
      await updateTask(task.id, { status: "dropped" });
      await settleReminders(task.id);
      return { text: `Dropped, sir. ${b(task.title)} is off the list.`, keyboard: null };

    // "Today", "This weekend": on that day at its own time if that is free, otherwise where his routine
    // puts this kind of task, never on top of something else.
    case "today":
    case "weekend": {
      let day = now;
      if (action === "weekend") {
        day = parseLocalDateTime(`${localDate(now)}T12:00`)!;
        for (let i = 0; i < 8 && (weekdayOf(day) !== "Sat" || localDate(day) === localDate(now)); i++) day = addMinutes(day, 24 * 60);
      }
      // No time of its own: he is asked, never placed silently (the app's lanes take Tony's best pick, "lane" below).
      if (!task.due_at) return askOnDay(task, day, now);
      const slot = await timeOnDay(task, day, now);
      const name = action === "today" ? "today" : "Saturday";
      if (!slot) return { text: `${name === "today" ? "Today" : "Saturday"} is full, sir; ${b(task.title)} stays where it is.`, keyboard: null };
      await updateTask(task.id, { due_at: slot.at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, slot.at);
      return { text: `✓ ${b(task.title)} → ${b(formatWhen(slot.at, now))}`, keyboard: null };
    }

    case "snooze": {
      const at = toWholeMinute(addMinutes(now, arg ?? 15));
      await scheduleReminder(task.id, at);
      return { text: `Very good, sir. I'll ask again at ${b(formatTime(at))}.`, keyboard: null };
    }

    case "move": {
      const at = arg === undefined ? toWholeMinute(addMinutes(now, 60)) : new Date(arg * 60_000);
      if (at.getTime() <= now.getTime()) {
        return { text: "That time has already passed, sir.", keyboard: null };
      }
      await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, at);
      // He chose this time himself: Tony learns where this kind of task belongs.
      await recordSample(task, at);
      return { text: `✓ ${b(task.title)} → ${b(formatWhen(at, now))}`, keyboard: null };
    }

    case "tomorrow": {
      // Tomorrow (after midnight: the coming morning) at its own time of day if that is free.
      // An undated task has no time of its own: he is asked, never placed silently.
      if (!task.due_at) return askOnDay(task, hisTomorrow(now), now);
      // Anytime (Phase J): tomorrow, still with no time.
      if (task.anytime) {
        const at = parseLocalDateTime(`${localDate(hisTomorrow(now))}T${String(ANYTIME_HOUR).padStart(2, "0")}:00`)!;
        await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
        await scheduleReminder(task.id, at);
        return { text: `✓ ${b(task.title)} → ${b(`${formatWhen(at, now).replace(/, \d{2}:\d{2}$/, "")}, anytime`)}`, keyboard: null };
      }
      const slot = await timeOnDay(task, hisTomorrow(now), now);
      if (!slot) return { text: `Tomorrow is full, sir; ${b(task.title)} stays where it is.`, keyboard: null };
      await updateTask(task.id, { due_at: slot.at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, slot.at);
      return { text: `✓ ${b(task.title)} → ${b(formatWhen(slot.at, now))}`, keyboard: null };
    }

    case "resched":
      return { keyboard: rescheduleKeyboard(task.id) };
  }
}
