/**
 * The words and buttons of Tony's one question for a day he named without a
 * time (Change 1, 21 Nov): the task, then "When on Mon 23 Nov? Best: 20:30,
 * <reason>.", what shapes the day, and the free times best first with
 * [✏️ Other time]. Pure: no database, no Telegram, tested in tests/change1.test.ts.
 */
import type { SlotOption } from "./routine-rules";
import { formatDay, formatTime, parseLocalDateTime, relativeDay } from "./time";

/**
 * A day in words, always with its weekday and date, "today" and "tomorrow"
 * by the day he is living (after midnight, the coming morning is "tomorrow"):
 * `when` reads "tomorrow, Sat 21 Nov," or "on Mon 23 Nov"; `plain` reads
 * "Tomorrow, Sat 21 Nov," or "Mon 23 Nov".
 */
export function dayLabel(day: string, now: Date): { when: string; plain: string } {
  const noon = parseLocalDateTime(`${day}T12:00`)!;
  const name = formatDay(noon, now);
  const relative = relativeDay(noon, now);
  if (!relative) return { when: `on ${name}`, plain: name };
  return { when: `${relative}, ${name},`, plain: `${relative[0].toUpperCase()}${relative.slice(1)}, ${name},` };
}

export type Button = { text: string; data: string };

const clock = (at: Date) => formatTime(at);
const minuteId = (at: Date) => Math.round(at.getTime() / 60_000);

/**
 * "**Watch: Mosseri AI setup** · 🔗 link
 *  When on Mon 23 Nov? Best: **20:30**, you usually watch videos around 20:30.
 *  10:00–14:00 is taken by **Watch: Instagram Masterclass**."
 * `when` is "on Mon 23 Nov" or "tomorrow, Sat 21 Nov". One question, no "inbox".
 */
export function slotQuestion(input: { title: string; marks: string; when: string; options: SlotOption[]; taken?: string }): string {
  const [best] = input.options;
  const reason = best.why ? `, ${best.why}` : "";
  const ask = input.options.length === 1 ? `Only **${clock(best.at)}** is free${reason}.` : `Best: **${clock(best.at)}**${reason}.`;
  return [`**${input.title}**${input.marks}`, `When ${input.when.replace(/,$/, "")}? ${ask}`, ...(input.taken ? [`${input.taken}.`] : [])].join("\n");
}

/** Tony's own pick, for a kind he said "decide yourself" for: the receipt says so and why. */
export function autoReceipt(input: { title: string; marks: string; when: string; why: string }): string {
  return `✓ **${input.title}** → ${input.when}${input.marks} · my pick: ${input.why}`;
}

/** Hours or minutes as he would say them: "4 h", "1 h 30 min", "45 min". */
export function lengthText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A long task with no gap for it: two halves are offered, never made without his tap. */
export function splitQuestion(input: { title: string; marks: string; when: string; minutes: number; total: number; parts: Date[] }): string {
  const [a, b] = input.parts;
  return `**${input.title}**${input.marks}: ${lengthText(input.total)} won't fit in one go ${input.when.replace(/,$/, "")}. Split it in two? **${clock(a)}** and **${clock(b)}**, ${lengthText(input.minutes)} each.`;
}

/** The buttons under the question: best first (⭐), then [✏️ Other time]; [✏️ Change] under Tony's own pick; [✂️ Split …] for halves. */
export function slotButtons(
  slot: { kind: "ask"; taskId: number; day: string; options: SlotOption[] } | { kind: "auto"; taskId: number; day: string } | { kind: "split"; taskId: number; day: string; parts: Date[] },
): Button[][] {
  const other = { text: "✏️ Other time", data: `sl:other:${slot.taskId}:${slot.day}` };
  if (slot.kind === "auto") return [[{ text: "✏️ Change", data: `sl:edit:${slot.taskId}:${slot.day}` }]];
  if (slot.kind === "split") {
    const [a, b] = slot.parts;
    return [[{ text: `✂️ Split ${clock(a)} + ${clock(b)}`, data: `sl:split:${slot.taskId}:${minuteId(a)}:${minuteId(b)}` }], [other]];
  }
  return [slot.options.map((option, index) => ({ text: `${index === 0 ? "⭐ " : ""}${clock(option.at)}`, data: `sl:at:${slot.taskId}:${minuteId(option.at)}` })), [other]];
}
