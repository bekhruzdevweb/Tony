import "server-only";
import { requireDb } from "./db";
import { env } from "./env";
import { logEvent } from "./events";
import { NOTIFY_LIMIT } from "./smart-rules";
import { voiceBudget } from "./speech";
import { dayBounds, localDate, minuteOfDay, TIMEZONE } from "./time";

/**
 * Safety and monitoring (phase e, 21 Nov): the day's budget of unasked
 * messages, jobs that run once a day (self-test, budget guard, backup), and
 * what the model costs. Everything is noted in `events` (migration 0022) and
 * never fails what it is guarding.
 */

// ── Notification budget: at most 8 unasked messages a day ───────────────

/** Notes an unasked message (a follow-up, a free-time suggestion, a rule sent on its own, the Sunday review). */
export async function notify(kind: string, now = new Date()): Promise<void> {
  await logEvent("notify", { kind, at: now.toISOString() });
}

/** How many unasked messages are left today (prayers, reminders he set and check-ins he asked for do not count). */
export async function budgetLeft(now = new Date()): Promise<number> {
  const { start } = dayBounds(now, TIMEZONE);
  const { count, error } = await requireDb().from("events").select("id", { count: "exact", head: true }).eq("kind", "notify").gte("created_at", start.toISOString());
  if (error) return NOTIFY_LIMIT;
  return Math.max(0, NOTIFY_LIMIT - (count ?? 0));
}

// ── Jobs that run once a day ─────────────────────────────────────────────

/** True once per day for a job, from its local time on; the run is noted first, so a slow job never starts twice. */
export async function dueToday(job: string, clock: string, now = new Date()): Promise<boolean> {
  const [hour, minute] = clock.split(":").map(Number);
  if (minuteOfDay(now) < hour * 60 + minute) return false;
  const { start } = dayBounds(now, TIMEZONE);
  const { count, error } = await requireDb().from("events").select("id", { count: "exact", head: true }).eq("kind", `job:${job}`).gte("created_at", start.toISOString());
  if (error || (count ?? 0) > 0) return false;
  await logEvent(`job:${job}`, { day: localDate(now) });
  return true;
}

// ── What the model costs ─────────────────────────────────────────────────

/** Dollars per million tokens: input, output, cache read, cache write (5-minute). */
const PRICES: { match: RegExp; price: [number, number, number, number] }[] = [
  { match: /haiku/, price: [0.1, 0.5, 0.01, 0.125] },
  { match: /opus/, price: [4, 20, 0.2, 5] },
  { match: /sonnet/, price: [2, 10, 0.1, 2.5] },
];

export type Usage = { model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number };

/** What one call cost, in dollars. */
export function costOf(usage: Usage): number {
  const [input, output, read, write] = (PRICES.find((entry) => entry.match.test(usage.model)) ?? PRICES[2]).price;
  return (usage.input * input + usage.output * output + (usage.cacheRead ?? 0) * read + (usage.cacheWrite ?? 0) * write) / 1_000_000;
}

/** Notes one call's tokens and cost (never waits for the database to answer the caller). */
export function recordUsage(usage: Usage): void {
  void logEvent("usage", { ...usage, cost: Math.round(costOf(usage) * 1_000_000) / 1_000_000 });
}

/** This month's spend on the model, in dollars, from the calls noted. */
export async function monthSpend(now = new Date()): Promise<number> {
  const month = `${localDate(now).slice(0, 7)}-01T00:00:00+05:00`;
  let total = 0;
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await requireDb().from("events").select("detail").eq("kind", "usage").gte("created_at", new Date(month).toISOString()).range(from, from + 999);
    if (error) break;
    const rows = (data ?? []) as { detail: { cost?: number } }[];
    total += rows.reduce((sum, row) => sum + Number(row.detail?.cost ?? 0), 0);
    if (rows.length < 1000) break;
  }
  return total;
}

/**
 * The budget guard: a warning at 80% of the voice plan's characters, and at
 * 80% of the month's model budget (ANTHROPIC_MONTHLY_BUDGET_USD) when one is
 * set. Each warning once a month.
 */
export async function budgetWarnings(now = new Date()): Promise<string[]> {
  const warnings: string[] = [];
  const month = localDate(now).slice(0, 7);
  const warnedThisMonth = async (what: string) => {
    const { data } = await requireDb().from("events").select("detail").eq("kind", "budget_warning").gte("created_at", new Date(`${month}-01T00:00:00+05:00`).toISOString());
    return ((data ?? []) as { detail: { what?: string } }[]).some((row) => row.detail?.what === what);
  };
  if (env.elevenLabsApiKey) {
    const voice = await voiceBudget(now).catch(() => undefined);
    if (voice && voice.share >= 0.8 && !(await warnedThisMonth("voice"))) {
      warnings.push(`🔊 Voice: ${Math.round(voice.share * 100)}% of this month's ElevenLabs characters used (${voice.used.toLocaleString("en-US")} of ${voice.limit.toLocaleString("en-US")}).`);
      await logEvent("budget_warning", { what: "voice", share: voice.share });
    }
  }
  const budget = Number(process.env.ANTHROPIC_MONTHLY_BUDGET_USD);
  if (Number.isFinite(budget) && budget > 0) {
    const spent = await monthSpend(now);
    if (spent / budget >= 0.8 && !(await warnedThisMonth("model"))) {
      warnings.push(`🧠 Model: about $${spent.toFixed(2)} of this month's $${budget.toFixed(0)} budget used (${Math.round((spent / budget) * 100)}%).`);
      await logEvent("budget_warning", { what: "model", spent, budget });
    }
  }
  return warnings;
}

// ── Daily backup: tasks, memory and the library ─────────────────────────

/** Today's copy of his tasks, memory and library (links and the files' descriptions); the last 14 kept. */
export async function runBackup(now = new Date()): Promise<boolean> {
  const db = requireDb();
  const [tasks, memory, library, media] = await Promise.all([
    db.from("tasks").select().neq("kind", "prayer").limit(5000),
    db.from("memory").select().limit(2000),
    db.from("library").select().limit(5000),
    db.from("media").select("id, kind, file_id, caption, description, note, task_id, created_at").limit(5000),
  ]);
  if (tasks.error || memory.error) {
    await logEvent("backup_failed", { error: (tasks.error ?? memory.error)!.message });
    return false;
  }
  const day = localDate(now);
  const row = { day, tasks: tasks.data ?? [], memory: memory.data ?? [], library: { links: library.error ? [] : (library.data ?? []), files: media.error ? [] : (media.data ?? []) } };
  const { error } = await db.from("backups").upsert(row, { onConflict: "day" });
  if (error) {
    await logEvent("backup_failed", { error: error.message });
    return false;
  }
  // The last 14 days are kept.
  const old = await db.from("backups").select("id, day").order("day", { ascending: false }).range(14, 200);
  const ids = ((old.data ?? []) as { id: number }[]).map((entry) => entry.id);
  if (ids.length) await db.from("backups").delete().in("id", ids);
  return true;
}

/** The newest backup, for /backup. */
export async function latestBackup(): Promise<{ day: string; json: string } | undefined> {
  const { data, error } = await requireDb().from("backups").select().order("day", { ascending: false }).limit(1);
  if (error) return undefined;
  const row = ((data ?? []) as { day: string; tasks: unknown; memory: unknown; library: unknown }[])[0];
  return row ? { day: row.day, json: JSON.stringify({ day: row.day, tasks: row.tasks, memory: row.memory, library: row.library }, null, 2) } : undefined;
}
