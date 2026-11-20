import "server-only";
import { retire } from "./chat-log";
import { requireDb } from "./db";
import { env } from "./env";
import { scheduleReminder, settleReminders } from "./reminders";
import { OPEN_STATUSES, PRAYER_KIND } from "./tasks";
export { isPrayer, PRAYER_KIND } from "./tasks";
import { addMinutes, dayBounds, localDate, minuteOfDay, parseLocalDateTime } from "./time";

/**
 * Prayer times. Every day at 00:05 the five times for Tashkent are fetched
 * from Aladhan and added as tasks in the "Prayer" project, each with a quiet
 * reminder 10 minutes before and one at the time. They are calm by design:
 * kept out of the task counts, overdue lists, nudges, polls and plans; no
 * follow-ups, no voice. A prayer left unticked is closed quietly at the next
 * day's fetch, so nothing carries over. /prayer turns it on or off.
 */
export const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;
const FETCH_FROM_MINUTE = 5; // 00:05
const BEFORE_MINUTES = 10;

type PrayerSettings = { prayer_on: boolean; prayer_method: number; prayer_school: number; prayer_day: string | null };

async function prayerSettings(): Promise<PrayerSettings | undefined> {
  const { data, error } = await requireDb().from("settings").select("prayer_on, prayer_method, prayer_school, prayer_day").limit(1).maybeSingle();
  // Without its columns (migration 0016 not applied) prayer times stay off.
  if (error || !data) return undefined;
  return data as PrayerSettings;
}

/** The five times for one local day, as "HH:MM", from Aladhan. */
export async function fetchPrayerTimes(day: string, method: number, school: number): Promise<Record<(typeof PRAYERS)[number], string>> {
  const [y, m, d] = day.split("-");
  const url = `${env.prayerApiBase}/v1/timingsByCity/${d}-${m}-${y}?city=Tashkent&country=Uzbekistan&method=${method}&school=${school}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
  if (!response.ok) throw new Error(`Aladhan answered ${response.status}`);
  const body = (await response.json()) as { code?: number; data?: { timings?: Record<string, string> } };
  const timings = body.data?.timings;
  if (!timings) throw new Error("Aladhan sent no timings");
  const out = {} as Record<(typeof PRAYERS)[number], string>;
  for (const name of PRAYERS) {
    // Times can come as "05:40 (+05)"; only the clock is wanted.
    const clock = /\d{1,2}:\d{2}/.exec(timings[name] ?? "")?.[0];
    if (!clock) throw new Error(`Aladhan sent no time for ${name}`);
    out[name] = clock.padStart(5, "0");
  }
  return out;
}

async function prayerProjectId(): Promise<number | null> {
  const { data } = await requireDb().from("projects").select("id").eq("name", "Prayer").maybeSingle();
  return (data as { id: number } | null)?.id ?? null;
}

/** Closes open prayers from before `before` without a word: they are not overdue tasks. */
async function closeOldPrayers(before: Date): Promise<void> {
  const db = requireDb();
  const { data, error } = await db.from("tasks").select("id").eq("kind", PRAYER_KIND).in("status", OPEN_STATUSES).lt("due_at", before.toISOString());
  if (error) throw new Error(`closeOldPrayers: ${error.message}`);
  for (const { id } of (data ?? []) as { id: number }[]) {
    await settleReminders(id);
    await retire({ taskId: id });
    await db.from("tasks").update({ status: "skipped" }).eq("id", id);
  }
}

/**
 * From the minute tick: once a day, from 00:05, today's times are fetched
 * and the five prayers added. `force` skips the 00:05 wait (used by /prayer on).
 * Returns how many were added. A failed fetch is tried again on a later tick.
 */
export async function ensurePrayers(now = new Date(), force = false): Promise<number> {
  const settings = await prayerSettings();
  if (!settings?.prayer_on) return 0;
  const today = localDate(now);
  if (String(settings.prayer_day ?? "").slice(0, 10) === today) return 0;
  if (!force && minuteOfDay(now) < FETCH_FROM_MINUTE) return 0;

  const { start } = dayBounds(now);
  await closeOldPrayers(start);

  const db = requireDb();
  const existing = await db.from("tasks").select("title").eq("kind", PRAYER_KIND).gte("due_at", start.toISOString()).lt("due_at", dayBounds(now).end.toISOString());
  if (existing.error) throw new Error(`ensurePrayers: ${existing.error.message}`);
  const have = new Set(((existing.data ?? []) as { title: string }[]).map((row) => row.title));

  const times = await fetchPrayerTimes(today, settings.prayer_method, settings.prayer_school);
  const project = await prayerProjectId();
  let added = 0;
  for (const name of PRAYERS) {
    if (have.has(name)) continue;
    const at = parseLocalDateTime(`${today}T${times[name]}`);
    if (!at) continue;
    const { data, error } = await db
      .from("tasks")
      .insert({ title: name, status: "todo", priority: 4, due_at: at.toISOString(), project_id: project, kind: PRAYER_KIND })
      .select("id")
      .single();
    if (error) throw new Error(`ensurePrayers: ${error.message}`);
    const id = (data as { id: number }).id;
    // The reminder at the time, then a quiet heads-up 10 minutes before (added after it, because
    // scheduling a reminder clears any other one waiting for the task); none for a time already gone.
    if (at.getTime() > now.getTime()) await scheduleReminder(id, at);
    const before = addMinutes(at, -BEFORE_MINUTES);
    if (before.getTime() > now.getTime()) {
      const extra = await db.from("reminders").insert({ task_id: id, fire_at: before.toISOString(), kind: "extra", attempt: 0 });
      if (extra.error) throw new Error(`ensurePrayers: ${extra.error.message}`);
    }
    added++;
  }
  await db.from("settings").update({ prayer_day: today }).eq("id", true);
  console.log(`Prayer times for ${today}: ${PRAYERS.map((name) => `${name} ${times[name]}`).join(", ")} (method ${settings.prayer_method}, school ${settings.prayer_school}); ${added} added.`);
  return added;
}

/** /prayer on|off. Off drops today's remaining prayers and their reminders. */
export async function setPrayer(on: boolean, now = new Date()): Promise<void> {
  const db = requireDb();
  const { error } = await db.from("settings").update({ prayer_on: on, ...(on ? { prayer_day: null } : {}) }).eq("id", true);
  if (error) throw new Error(`setPrayer: ${error.message}`);
  if (on) {
    // Prayers dropped by an earlier /prayer off today come back.
    const { start, end } = dayBounds(now);
    await db.from("tasks").delete().eq("kind", PRAYER_KIND).eq("status", "dropped").gte("due_at", start.toISOString()).lt("due_at", end.toISOString());
    await ensurePrayers(now, true);
    return;
  }
  const open = await db.from("tasks").select("id").eq("kind", PRAYER_KIND).in("status", OPEN_STATUSES);
  for (const { id } of (open.data ?? []) as { id: number }[]) {
    await settleReminders(id);
    await retire({ taskId: id });
    await db.from("tasks").update({ status: "dropped" }).eq("id", id);
  }
}

/** /prayer method <n> or /prayer hanafi|standard: today's times are fetched again with the new setting. */
export async function setPrayerCalculation(change: { method?: number; school?: number }, now = new Date()): Promise<void> {
  const db = requireDb();
  const { error } = await db.from("settings").update({ ...(change.method !== undefined ? { prayer_method: change.method } : {}), ...(change.school !== undefined ? { prayer_school: change.school } : {}), prayer_day: null }).eq("id", true);
  if (error) throw new Error(`setPrayerCalculation: ${error.message}`);
  // Today's prayers that have not come yet are replaced by ones at the new times.
  const later = await db.from("tasks").select("id").eq("kind", PRAYER_KIND).in("status", OPEN_STATUSES).gt("due_at", now.toISOString());
  for (const { id } of (later.data ?? []) as { id: number }[]) {
    await settleReminders(id);
    await retire({ taskId: id });
    await db.from("tasks").delete().eq("id", id);
  }
  await ensurePrayers(now, true);
}

/** What /prayer shows: on or off, the calculation, and today's times. */
export async function prayerStatus(now = new Date()): Promise<{ on: boolean; method: number; school: number; today: { title: string; at: string; status: string }[] } | undefined> {
  const settings = await prayerSettings();
  if (!settings) return undefined;
  const { start, end } = dayBounds(now);
  const { data } = await requireDb().from("tasks").select("title, due_at, status").eq("kind", PRAYER_KIND).gte("due_at", start.toISOString()).lt("due_at", end.toISOString()).order("due_at");
  return {
    on: settings.prayer_on,
    method: settings.prayer_method,
    school: settings.prayer_school,
    today: ((data ?? []) as { title: string; due_at: string; status: string }[]).filter((row) => row.status !== "dropped" && row.status !== "skipped").map((row) => ({ title: row.title, at: row.due_at, status: row.status })),
  };
}
