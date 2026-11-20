import "server-only";
import { requireDb } from "./db";
import { itemLabel, type LibraryItem } from "./library-rules";
import { itemRef, loadItem } from "./library";
import { getRoutine } from "./routine";
import { kindOf, windowsOn, weekdayOf, type Kind } from "./routine-rules";
import { getSettings } from "./settings";
import { budgetLeft, notify } from "./safety";
import { skipTrigger } from "./smart-rules";
import { minuteOfDay } from "./time";

/**
 * Situation rules (phase b, 21 Nov): "when I'm not motivated to work out,
 * send me this video". Saved as the situation in his words, what to do, and
 * the item; acted on when a later message fits (the brain decides, with
 * empathy, the item and a helpful offer), and on its own when he has gone
 * days without that kind of task. "Show my rules" lists them, each with 🗑.
 */

export type Rule = {
  id: number;
  situation: string;
  action: string;
  media_id: number | null;
  library_id: number | null;
  skip_kind: string | null;
  skip_days: number | null;
  active: boolean;
  last_fired_at: string | null;
  created_at: string;
};

const HOUR = 60 * 60_000;
const DAY_MS = 24 * HOUR;

/** His active rules, oldest first. Before migration 0024: none. */
export async function listRules(): Promise<Rule[]> {
  const { data, error } = await requireDb().from("rules").select().eq("active", true).order("id");
  if (error) return [];
  return (data ?? []) as Rule[];
}

/** The item a rule sends, if it has one. */
export async function ruleItem(rule: Pick<Rule, "media_id" | "library_id">): Promise<LibraryItem | undefined> {
  if (rule.media_id) return loadItem(`media:${rule.media_id}`);
  if (rule.library_id) return loadItem(`library:${rule.library_id}`);
  return undefined;
}

/** The thing he means by "this video" when he makes a rule: what he shared in the last two hours. */
async function lastShared(now: Date): Promise<LibraryItem | undefined> {
  const db = requireDb();
  const settings = await getSettings().catch(() => undefined);
  const since = new Date(now.getTime() - 2 * HOUR).toISOString();
  const media = settings?.last_shared_media_id ? await loadItem(`media:${settings.last_shared_media_id}`) : undefined;
  const link = await db.from("library").select("id, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(1);
  const linkRow = link.error ? undefined : ((link.data ?? []) as { id: number; created_at: string }[])[0];
  const recentMedia = media && media.created_at >= since ? media : undefined;
  if (recentMedia && (!linkRow || recentMedia.created_at >= linkRow.created_at)) return recentMedia;
  return linkRow ? loadItem(`library:${linkRow.id}`) : undefined;
}

/** A new rule, read back. `item` is "last" (what he just shared) or a library reference ("media:7"). */
export async function addRule(input: { situation: string; action: string; item?: string }, now = new Date()): Promise<{ ok: true; rule: Rule; item?: LibraryItem } | { ok: false; error: string }> {
  const situation = input.situation.trim().slice(0, 300);
  const action = input.action.trim().slice(0, 300);
  if (!situation || !action) return { ok: false, error: "a rule needs the situation and what to do" };
  const item = input.item === "last" ? await lastShared(now) : input.item ? await loadItem(input.item) : undefined;
  if (input.item && !item) return { ok: false, error: "nothing to attach: he has not shared anything in the last two hours" };
  const skip = skipTrigger(situation);
  const { data, error } = await requireDb()
    .from("rules")
    .insert({
      situation,
      action,
      media_id: item?.source === "media" ? item.id : null,
      library_id: item?.source === "library" ? item.id : null,
      skip_kind: skip?.kind ?? null,
      skip_days: skip?.days ?? null,
    })
    .select()
    .single();
  if (error) return { ok: false, error: "the rule could not be saved" };
  return { ok: true, rule: data as Rule, item };
}

/** Removes a rule (his 🗑 tap, or his words), read back. */
export async function deleteRule(id: number): Promise<boolean> {
  const db = requireDb();
  await db.from("rules").update({ active: false }).eq("id", id);
  const back = await db.from("rules").select("active").eq("id", id).maybeSingle();
  return (back.data as { active?: boolean } | null)?.active === false;
}

/** A rule acted on: noted, so the proactive check does not send it again too soon. */
export async function fireRule(id: number, now = new Date()): Promise<{ rule: Rule; item?: LibraryItem } | undefined> {
  const db = requireDb();
  const { data } = await db.from("rules").select().eq("id", id).eq("active", true).maybeSingle();
  const rule = data as Rule | null;
  if (!rule) return undefined;
  await db.from("rules").update({ last_fired_at: now.toISOString() }).eq("id", id);
  return { rule, item: await ruleItem(rule) };
}

/** His rules in a few lines, for the brain: "#1 when he's not motivated to work out → send the video [▶️ …]". */
export async function rulesForPrompt(rules: Rule[], now = new Date()): Promise<string | undefined> {
  if (rules.length === 0) return undefined;
  const lines = await Promise.all(
    rules.map(async (rule) => {
      const item = await ruleItem(rule).catch(() => undefined);
      return `#${rule.id} when ${rule.situation.replace(/^when\s+/i, "")} → ${rule.action}${item ? ` [${itemRef(item)} ${itemLabel(item, now)}]` : ""}`;
    }),
  );
  return lines.join("\n");
}

/** The view for "show my rules": numbered, each with 🗑. */
export async function rulesView(now = new Date()): Promise<{ text: string; rows: { text: string; data: string }[][] }> {
  const rules = await listRules();
  if (rules.length === 0) return { text: "No rules yet, sir. Tell me one like \"when I'm not motivated to work out, send me this video\".", rows: [] };
  const lines = await Promise.all(
    rules.map(async (rule, index) => {
      const item = await ruleItem(rule).catch(() => undefined);
      const auto = rule.skip_kind && rule.skip_days ? ` _(also after ${rule.skip_days} days without ${rule.skip_kind === "workout" ? "a workout" : rule.skip_kind})_` : "";
      return `${index + 1}. When ${rule.situation.replace(/^when\s+/i, "")} → ${rule.action}${item ? ` · ${itemLabel(item, now)}` : ""}${auto}`;
    }),
  );
  const rows: { text: string; data: string }[][] = [];
  rules.forEach((rule, index) => {
    if (index % 5 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: `🗑 ${index + 1}`, data: `ru:del:${rule.id}` });
  });
  return { text: ["**Your rules.** Tap a number to remove it:", ...lines].join("\n"), rows };
}

/** When he last finished a task of this kind (within 30 days). */
async function lastDone(kind: Kind, now: Date): Promise<Date | undefined> {
  const { data } = await requireDb()
    .from("tasks")
    .select("title, project_id, completed_at")
    .eq("status", "done")
    .gte("completed_at", new Date(now.getTime() - 30 * DAY_MS).toISOString())
    .order("completed_at", { ascending: false })
    .limit(200);
  const row = ((data ?? []) as { title: string; completed_at: string }[]).find((task) => kindOf(task.title) === kind);
  return row ? new Date(row.completed_at) : undefined;
}

/**
 * On its own: a rule about a kind of task (workouts) fires when he has gone
 * that many days without one, at the start of that kind's hours in his
 * routine (or 18:00), once per those days, within the day's budget. The item
 * comes with a short, kind line.
 */
export async function runRuleChecks(now: Date, send: (text: string, item?: LibraryItem) => Promise<number | undefined>): Promise<number> {
  const rules = (await listRules()).filter((rule) => rule.skip_kind && rule.skip_days);
  if (rules.length === 0) return 0;
  const routine = await getRoutine();
  let sent = 0;
  for (const rule of rules) {
    const kind = rule.skip_kind as Kind;
    const field = kind === "workout" || kind === "content" || kind === "coding" ? kind : undefined;
    const window = field ? windowsOn(routine[field], weekdayOf(now))[0] : undefined;
    const startMinute = window?.start ?? 18 * 60;
    const minute = minuteOfDay(now);
    if (minute < startMinute || minute > startMinute + 90) continue;
    if (rule.last_fired_at && now.getTime() - new Date(rule.last_fired_at).getTime() < rule.skip_days! * DAY_MS) continue;
    const since = new Date(rule.created_at);
    const done = await lastDone(kind, now);
    const quietFor = (now.getTime() - (done ?? since).getTime()) / DAY_MS;
    if (quietFor < rule.skip_days!) continue;
    // Only for something he does: a recent one, or hours for it in his routine.
    if (!done && !window) continue;
    if ((await budgetLeft(now)) <= 0) return sent;
    const item = await ruleItem(rule);
    const what = kind === "workout" ? "a workout" : kind;
    const days = Math.floor(quietFor);
    const id = await send(`${days} days without ${what}, sir. You asked me to send this when it gets hard: ${rule.action}.`, item);
    if (id !== undefined) {
      await requireDb().from("rules").update({ last_fired_at: now.toISOString() }).eq("id", rule.id);
      await notify("rule", now);
      sent++;
    }
  }
  return sent;
}
