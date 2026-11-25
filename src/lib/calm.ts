/**
 * Phase N (25 Nov: "every time I send him a task he still asks me with options", and "for now turn off the keep
 * asking feature … he reminds me again after 1 hour and deletes his old message"). Pure rules, so they are tested
 * without a database.
 *
 * Capture is quiet: a new thing with no day goes to the inbox with one line and no question, unless he asks Tony
 * to find it a time. Reminders are calm: one at the task's time, one repeat an hour later if he has not tapped
 * (the earlier message is removed), then nothing until the evening review. The older chases (the urgent ladder,
 * the main priority's nudges, the same-day "still open" message) stay in the code, switched off here.
 */
export const CALM_REMINDERS = true;

/** Minutes after its first message that a reminder is repeated, once. */
export const REPEAT_AFTER_MINUTES = 60;

/** The steps of a calm reminder, in minutes after its first message. */
export const CALM_OFFSETS = [0, REPEAT_AFTER_MINUTES];

/** Whether he asked Tony to find a time for a new thing with no day ("suggest a time", "when should I do it", "fit it in"). */
export function asksForATime(said: string): boolean {
  return /\b(suggest|recommend|propose)\b|\bwhen (should|can|could|do) i\b|\b(find|pick|choose|give) (me |it |this |that )?(a |the |some )?(good |free |best )?(time|day|slot)\b|\bfit (it|this|that) in\b|\bschedule (it|this|that) for me\b/i.test(said);
}
