import "server-only";
import { InlineKeyboard } from "grammy";
import { habitStats, planProgress, streakLine, weekMarks, type HabitStats, type PlanProgress } from "./habits";
import { b, esc, i } from "./html";
import { formatTime } from "./time";

/** A habit's name on a button: "✓ Reading", short enough to fit. */
const buttonName = (title: string) => (title.length > 24 ? `${title.slice(0, 23).trimEnd()}…` : title);

/** "IELTS · 2/3 done this week" (and what was skipped). */
export const planLine = (plan: PlanProgress) => `${plan.name} · ${plan.done}/${plan.due} done${plan.skipped ? ` · ${plan.skipped} skipped` : ""}`;

/** One habit in /habits: its name and time, this week Monday to Sunday, and its run. */
function habitBlock(stats: HabitStats): string {
  const at = stats.task.due_at ? ` · ${formatTime(new Date(stats.task.due_at))}` : "";
  return [`${b(stats.task.title)}${at}`, `<code>M T W T F S S</code>`, `<code>${esc(weekMarks(stats))}</code>`, `${i(streakLine(stats))} · best ${stats.best}`].join("\n");
}

/**
 * /habits (Phase H): each habit's week (✓ done, – skipped, ✗ missed, ○ today,
 * · ahead), its run and best, and a ✓ for each one still to do today; then
 * his plans' progress this week ("IELTS · 2/3 done"). Plain code, every
 * number from the log.
 */
export async function habitsView(now = new Date(), lead?: string): Promise<{ html: string; keyboard?: InlineKeyboard }> {
  const [habits, plans] = await Promise.all([habitStats(now), planProgress(now)]);
  const parts = [...(lead ? [esc(lead)] : []), `<b>🔥 Your habits</b>`];
  if (habits.length === 0) parts.push(esc('None yet, sir. Say "make reading a daily habit at 21:00" and I\'ll keep count.'));
  else parts.push(...habits.map(habitBlock));
  if (plans.length > 0) parts.push([`<b>📈 Plans this week</b>`, ...plans.map((plan) => esc(planLine(plan)))].join("\n"));
  const open = habits.filter((stats) => stats.dueToday && !stats.doneToday);
  if (open.length === 0) return { html: parts.join("\n\n") };
  const keyboard = new InlineKeyboard();
  open.slice(0, 8).forEach((stats, index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(`✓ ${buttonName(stats.task.title)}`, `hb:${stats.task.id}`);
  });
  return { html: parts.join("\n\n"), keyboard };
}

/** The Sunday review's line: each habit's week and each plan's ("🔥 Reading 6/7 · 📈 IELTS 5/6"). Undefined with neither. */
export async function weekLine(now = new Date()): Promise<string | undefined> {
  const [habits, plans] = await Promise.all([habitStats(now).catch(() => []), planProgress(now).catch(() => [])]);
  const habitParts = habits
    .map((stats) => {
      const due = stats.week.filter((entry) => entry.state === "done" || entry.state === "missed" || entry.state === "due").length;
      const done = stats.week.filter((entry) => entry.state === "done").length;
      return due > 0 ? `${stats.task.title} ${done}/${due}` : undefined;
    })
    .filter(Boolean);
  const planParts = plans.map((plan) => `${plan.name} ${plan.done}/${plan.due}`);
  const lines = [habitParts.length ? `🔥 ${habitParts.join(" · ")}` : undefined, planParts.length ? `📈 ${planParts.join(" · ")}` : undefined].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}
