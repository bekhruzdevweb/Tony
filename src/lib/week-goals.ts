import "server-only";
import { requireDb } from "./db";
import { localDate } from "./time";
import { MAX_WEEK_GOALS, shiftDay, weekStart } from "./week-rules";

/** One outcome he chose for a week (Phase P). */
export type WeekGoal = { id: number; week_start: string; title: string; done: boolean; project_id: number | null; created_at: string };

/** This week's and next week's outcomes, oldest first. Before migration 0034 the table is missing: none. */
export async function weekGoals(now = new Date()): Promise<WeekGoal[]> {
  const monday = weekStart(localDate(now));
  const { data, error } = await requireDb().from("week_goals").select().in("week_start", [monday, shiftDay(monday, 7)]).order("id");
  if (error) return [];
  return (data ?? []) as WeekGoal[];
}

/** Adds an outcome to a week: five at most, the same words once. */
export async function addWeekGoal(input: { title: string; week: string; projectId?: number | null }): Promise<{ ok: true; goal: WeekGoal } | { ok: false; error: string }> {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!title) return { ok: false, error: "An outcome needs a few words" };
  const db = requireDb();
  const known = await db.from("week_goals").select().eq("week_start", input.week);
  if (known.error) return { ok: false, error: "Could not read the week's outcomes" };
  const rows = (known.data ?? []) as WeekGoal[];
  if (rows.some((row) => row.title.toLowerCase() === title.toLowerCase())) return { ok: false, error: "That outcome is already on the week" };
  if (rows.length >= MAX_WEEK_GOALS) return { ok: false, error: `A week holds ${MAX_WEEK_GOALS} outcomes at most: remove one first` };
  const { data, error } = await db.from("week_goals").insert({ week_start: input.week, title, project_id: input.projectId ?? null }).select().single();
  if (error) return { ok: false, error: "Could not save the outcome" };
  return { ok: true, goal: data as WeekGoal };
}

/** Ticks an outcome, or unticks it. */
export async function setWeekGoalDone(id: number, done: boolean): Promise<boolean> {
  const { data, error } = await requireDb().from("week_goals").update({ done }).eq("id", id).select("id");
  return !error && (data ?? []).length > 0;
}

export async function removeWeekGoal(id: number): Promise<boolean> {
  const { data, error } = await requireDb().from("week_goals").delete().eq("id", id).select("id");
  return !error && (data ?? []).length > 0;
}

/** The outcomes for Tony's prompt: "This week: ☐ Launch the website · ☑ Study 10 hours". */
export async function weekGoalsForPrompt(now = new Date()): Promise<string | undefined> {
  const goals = await weekGoals(now).catch(() => [] as WeekGoal[]);
  if (goals.length === 0) return undefined;
  const monday = weekStart(localDate(now));
  const line = (label: string, rows: WeekGoal[]) => (rows.length ? `${label}: ${rows.map((goal) => `#g${goal.id} ${goal.done ? "☑" : "☐"} ${goal.title}`).join(" · ")}` : undefined);
  return [line("This week", goals.filter((goal) => goal.week_start === monday)), line("Next week", goals.filter((goal) => goal.week_start !== monday))].filter(Boolean).join("\n");
}
