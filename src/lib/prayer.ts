import "server-only";
import { retire } from "./chat-log";
import { requireDb } from "./db";
import { env } from "./env";
import { scheduleReminder, settleReminders } from "./reminders";
import { OPEN_STATUSES, PRAYER_KIND } from "./tasks";
export { isPrayer, PRAYER_KIND } from "./tasks";
import { addMinutes, dayBounds, localDate, minuteOfDay, parseLocalDateTime } from "./time";

/**
 * Prayer times for where he lives (a setting: /location; Xonqa tumani,
 * Xorazm by default). The official times of the Muslim Board of Uzbekistan
 * come from namoz-vaqti.uz as a table of the next month or so; it is fetched
 * when the stored table has no row for today (about once a month) and kept
 * in prayer_times. Each day from 00:05 today's row becomes five tasks in the
 * "Prayer" project, each with a quiet reminder 10 minutes before and one at
 * the time. If the site cannot be read, Aladhan by coordinates (Hanafi Asr)
 * stands in and those reminders say "(approx.)".
 *
 * Calm by design: kept out of the task counts, overdue lists, nudges, polls
 * and plans; no follow-ups, no voice. A prayer left unticked is closed
 * quietly at the next day's fetch. /prayer turns it on or off.
 */
export const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;
type Times = Record<(typeof PRAYERS)[number], string>;
const FETCH_FROM_MINUTE = 5; // 00:05
const BEFORE_MINUTES = 10;
/** Marks a prayer whose time came from the fallback. */
export const APPROX = "approx.";

type PrayerSettings = {
  prayer_on: boolean;
  prayer_method: number;
  prayer_school: number;
  prayer_day: string | null;
  location_slug: string;
  location_name: string;
  location_lat: number;
  location_lng: number;
};

async function prayerSettings(): Promise<PrayerSettings | undefined> {
  const { data, error } = await requireDb()
    .from("settings")
    .select("prayer_on, prayer_method, prayer_school, prayer_day, location_slug, location_name, location_lat, location_lng")
    .limit(1)
    .maybeSingle();
  // Without its columns (migrations 0016-0017 not applied) prayer times stay off.
  if (error || !data) return undefined;
  return data as PrayerSettings;
}

const clean = (text: string) => text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * The official table for a region from namoz-vaqti.uz: one row per day
 * (Sana, Bomdod, Quyosh, Peshin, Asr, Shom, Xufton), and the region's name.
 */
export async function fetchOfficialTable(slug: string): Promise<{ name: string; rows: { day: string; times: Times }[] }> {
  const response = await fetch(`${env.prayerSiteBase}/lotin/namoz-vaqtlari/${encodeURIComponent(slug)}/oylik`, {
    signal: AbortSignal.timeout(12_000),
    redirect: "follow",
    headers: { "Accept-Language": "uz" },
  });
  if (!response.ok) throw new Error(`namoz-vaqti.uz answered ${response.status} for "${slug}"`);
  const html = await response.text();
  const table = /<table[^>]*prayer-table[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) throw new Error(`namoz-vaqti.uz has no table for "${slug}"`);
  const rows: { day: string; times: Times }[] = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(clean);
    const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(cells[0] ?? "");
    const clocks = cells.slice(1).map((cell) => /^\d{1,2}:\d{2}$/.test(cell) ? cell.padStart(5, "0") : "");
    // Bomdod, Quyosh (sunrise, not a prayer), Peshin, Asr, Shom, Xufton.
    if (!date || clocks.length < 6 || clocks.some((clock) => !clock)) continue;
    rows.push({ day: `${date[3]}-${date[2]}-${date[1]}`, times: { Fajr: clocks[0], Dhuhr: clocks[2], Asr: clocks[3], Maghrib: clocks[4], Isha: clocks[5] } });
  }
  if (rows.length === 0) throw new Error(`namoz-vaqti.uz table for "${slug}" had no rows`);
  const heading = clean(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "").replace(/\s*namoz vaqtlari.*$/i, "");
  return { name: heading || slug, rows };
}

/** The fallback: Aladhan by coordinates, for one day. */
async function fetchApproxTimes(day: string, settings: PrayerSettings): Promise<Times> {
  const [y, m, d] = day.split("-");
  const url = `${env.prayerApiBase}/v1/timings/${d}-${m}-${y}?latitude=${settings.location_lat}&longitude=${settings.location_lng}&method=${settings.prayer_method}&school=${settings.prayer_school}&timezonestring=Asia/Tashkent`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
  if (!response.ok) throw new Error(`Aladhan answered ${response.status}`);
  const timings = ((await response.json()) as { data?: { timings?: Record<string, string> } }).data?.timings;
  if (!timings) throw new Error("Aladhan sent no timings");
  const out = {} as Times;
  for (const name of PRAYERS) {
    // Times can come as "05:40 (+05)"; only the clock is wanted.
    const clock = /\d{1,2}:\d{2}/.exec(timings[name] ?? "")?.[0];
    if (!clock) throw new Error(`Aladhan sent no time for ${name}`);
    out[name] = clock.padStart(5, "0");
  }
  return out;
}

type Row = { fajr: string; dhuhr: string; asr: string; maghrib: string; isha: string; source: string };
const toTimes = (row: Row): Times => ({ Fajr: row.fajr, Dhuhr: row.dhuhr, Asr: row.asr, Maghrib: row.maghrib, Isha: row.isha });

/** Stores the official table (one row per day), replacing what was there. */
async function storeTable(region: string, rows: { day: string; times: Times }[]): Promise<void> {
  const { error } = await requireDb()
    .from("prayer_times")
    .upsert(
      rows.map(({ day, times }) => ({ region, day, fajr: times.Fajr, dhuhr: times.Dhuhr, asr: times.Asr, maghrib: times.Maghrib, isha: times.Isha, source: "official", fetched_at: new Date().toISOString() })),
      { onConflict: "region,day" },
    );
  if (error) throw new Error(`storeTable: ${error.message}`);
}

/**
 * Today's five times: from the stored official table; if today is not in
 * it, the table is fetched again (about once a month); if the site cannot
 * be read, Aladhan by coordinates, marked approximate.
 */
async function timesFor(day: string, settings: PrayerSettings): Promise<{ times: Times; approx: boolean }> {
  const db = requireDb();
  const stored = async () => {
    const { data } = await db.from("prayer_times").select("fajr, dhuhr, asr, maghrib, isha, source").eq("region", settings.location_slug).eq("day", day).maybeSingle();
    return data as Row | null;
  };
  let row = await stored();
  if (!row || row.source !== "official") {
    try {
      const table = await fetchOfficialTable(settings.location_slug);
      await storeTable(settings.location_slug, table.rows);
      console.log(`Prayer table for ${settings.location_slug}: ${table.rows.length} days from namoz-vaqti.uz (${table.rows[0].day} to ${table.rows[table.rows.length - 1].day}).`);
      row = await stored();
    } catch (error) {
      console.error("The official prayer table could not be read; using Aladhan by coordinates:", error);
    }
  }
  if (row && row.source === "official") return { times: toTimes(row), approx: false };
  return { times: await fetchApproxTimes(day, settings), approx: true };
}

/** /location <region>: checks namoz-vaqti.uz knows it, then makes it his location. Returns its name. */
export async function setLocation(input: string, now = new Date()): Promise<string> {
  // "Xonqa tumani", "xonqa", "Xiva shahri" -> the site's address form ("xonqa", "xiva-shahri").
  const slug = input
    .toLowerCase()
    .replace(/[‘’ʻʼ'`]/g, "")
    .replace(/\s+tumani$/, "")
    .trim()
    .replace(/\s+/g, "-");
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new Error("That does not look like a region name.");
  const table = await fetchOfficialTable(slug);
  await storeTable(slug, table.rows);
  const { error } = await requireDb().from("settings").update({ location_slug: slug, location_name: table.name, prayer_day: null }).eq("id", true);
  if (error) throw new Error(`setLocation: ${error.message}`);
  await replaceRemainingPrayers(now);
  return table.name;
}

/** /location <lat> <lng>: the coordinates the fallback uses. */
export async function setCoordinates(lat: number, lng: number): Promise<void> {
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new Error("Those are not coordinates.");
  const { error } = await requireDb().from("settings").update({ location_lat: lat, location_lng: lng }).eq("id", true);
  if (error) throw new Error(`setCoordinates: ${error.message}`);
}

/** Where he is, for /location and /prayer. */
export async function locationStatus(): Promise<{ slug: string; name: string; lat: number; lng: number } | undefined> {
  const settings = await prayerSettings();
  return settings ? { slug: settings.location_slug, name: settings.location_name, lat: settings.location_lat, lng: settings.location_lng } : undefined;
}

/** Today's prayers still ahead are replaced by ones at the current settings' times. */
async function replaceRemainingPrayers(now: Date): Promise<void> {
  const db = requireDb();
  const later = await db.from("tasks").select("id").eq("kind", PRAYER_KIND).in("status", OPEN_STATUSES).gt("due_at", now.toISOString());
  for (const { id } of (later.data ?? []) as { id: number }[]) {
    await settleReminders(id);
    await retire({ taskId: id });
    await db.from("tasks").delete().eq("id", id);
  }
  await ensurePrayers(now, true);
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

  const { times, approx } = await timesFor(today, settings);
  const project = await prayerProjectId();
  let added = 0;
  for (const name of PRAYERS) {
    if (have.has(name)) continue;
    const at = parseLocalDateTime(`${today}T${times[name]}`);
    if (!at) continue;
    const { data, error } = await db
      .from("tasks")
      .insert({ title: name, status: "todo", priority: 4, due_at: at.toISOString(), project_id: project, kind: PRAYER_KIND, notes: approx ? APPROX : null })
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
  console.log(`Prayer times for ${today} in ${settings.location_name}: ${PRAYERS.map((name) => `${name} ${times[name]}`).join(", ")} (${approx ? `approx.: Aladhan, method ${settings.prayer_method}, school ${settings.prayer_school}` : "official: namoz-vaqti.uz"}); ${added} added.`);
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

/** /prayer method <n> or /prayer hanafi|standard: these shape the fallback (Aladhan) only. */
export async function setPrayerCalculation(change: { method?: number; school?: number }, now = new Date()): Promise<void> {
  const db = requireDb();
  const { error } = await db.from("settings").update({ ...(change.method !== undefined ? { prayer_method: change.method } : {}), ...(change.school !== undefined ? { prayer_school: change.school } : {}), prayer_day: null }).eq("id", true);
  if (error) throw new Error(`setPrayerCalculation: ${error.message}`);
  await replaceRemainingPrayers(now);
}

/** What /prayer shows: on or off, the calculation, and today's times. */
export async function prayerStatus(now = new Date()): Promise<{ on: boolean; method: number; school: number; location: string; today: { title: string; at: string; status: string; approx: boolean }[] } | undefined> {
  const settings = await prayerSettings();
  if (!settings) return undefined;
  const { start, end } = dayBounds(now);
  const { data } = await requireDb().from("tasks").select("title, due_at, status, notes").eq("kind", PRAYER_KIND).gte("due_at", start.toISOString()).lt("due_at", end.toISOString()).order("due_at");
  return {
    on: settings.prayer_on,
    method: settings.prayer_method,
    school: settings.prayer_school,
    location: settings.location_name,
    today: ((data ?? []) as { title: string; due_at: string; status: string; notes: string | null }[])
      .filter((row) => row.status !== "dropped" && row.status !== "skipped")
      .map((row) => ({ title: row.title, at: row.due_at, status: row.status, approx: row.notes === APPROX })),
  };
}
