import "server-only";
import { requireDb } from "./db";
import {
  DEFAULT_ROUTINE,
  ROUTINE_FIELDS,
  decideSlot,
  kindOf,
  localMidnight,
  nearestFree,
  normalizeField,
  slotChoices,
  withSample,
  type Decision,
  type Interval,
  type Part,
  type Routine,
  type RoutineField,
} from "./routine-rules";
import { busyIntervals, estimateMinutes } from "./schedule";
import { OPEN_STATUSES, type Task } from "./tasks";
import { minuteOfDay } from "./time";

/**
 * His routine profile (one row), read by every scheduling decision, and what
 * Tony learns from the tasks he moves. The rules themselves are in
 * routine-rules.ts.
 */

const HOUR = 60 * 60_000;

/** His routine; the defaults (awake 07:00–23:00, nothing else set) until he tells Tony more. */
export async function getRoutine(): Promise<Routine> {
  const db = requireDb();
  const { data, error } = await db.from("routine").select().limit(1).maybeSingle();
  if (error) {
    console.error(`getRoutine: ${error.message}`);
    return DEFAULT_ROUTINE;
  }
  if (!data) {
    await db.from("routine").insert({ id: true });
    return DEFAULT_ROUTINE;
  }
  const row = data as Partial<Routine>;
  return { ...DEFAULT_ROUTINE, ...row, learned: (row.learned as Routine["learned"]) ?? {} };
}

/** One field of his routine, from his words, checked and read back. */
export async function setRoutineField(field: string, value: string): Promise<{ ok: true; field: RoutineField; value: string | null } | { ok: false; error: string }> {
  if (!(ROUTINE_FIELDS as readonly string[]).includes(field)) return { ok: false, error: `unknown routine field "${field}"` };
  const key = field as RoutineField;
  const normalized = normalizeField(key, value);
  if (normalized === undefined || ((key === "wake" || key === "sleep") && normalized === null)) {
    return { ok: false, error: `could not read "${value}" for ${field}. Use hours like "Mon-Fri 14:00-18:00" or "10:00-12:00", days like "Sun", or a clock time like "07:00".` };
  }
  await getRoutine();
  const { error } = await requireDb()
    .from("routine")
    .update({ [key]: normalized, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) return { ok: false, error: error.message };
  const stored = await getRoutine();
  return stored[key] === normalized ? { ok: true, field: key, value: normalized } : { ok: false, error: "it did not save" };
}

async function projectName(projectId: number | null | undefined): Promise<string | undefined> {
  if (!projectId) return undefined;
  const { data } = await requireDb().from("projects").select("name").eq("id", projectId).maybeSingle();
  return (data as { name?: string } | null)?.name;
}

/**
 * He moved a task to a new time himself (in words, with a button, or in the
 * app): Tony learns that this kind of task belongs around that time.
 */
export async function recordMove(task: Pick<Task, "title"> & Partial<Pick<Task, "project_id" | "kind">>, at: Date): Promise<void> {
  if (task.kind === "prayer") return;
  try {
    const kind = kindOf(task.title, await projectName(task.project_id));
    const routine = await getRoutine();
    await requireDb()
      .from("routine")
      .update({ learned: withSample(routine.learned, kind, minuteOfDay(at)), updated_at: new Date().toISOString() })
      .eq("id", true);
  } catch (error) {
    console.error("recordMove failed:", error);
  }
}

/** What is already on the list around that day: every open timed task for its length, prayers ±15 minutes. */
export async function busyAround(day: Date, except: number[] = []): Promise<Interval[]> {
  const midnight = localMidnight(day);
  const { data, error } = await requireDb()
    .from("tasks")
    .select()
    .in("status", OPEN_STATUSES)
    .not("due_at", "is", null)
    .gte("due_at", new Date(midnight - 6 * HOUR).toISOString())
    .lt("due_at", new Date(midnight + 30 * HOUR).toISOString());
  if (error) throw new Error(`busyAround: ${error.message}`);
  return busyIntervals(((data ?? []) as Task[]).filter((task) => !except.includes(task.id)));
}

type Placeable = Pick<Task, "id" | "title"> & Partial<Pick<Task, "duration_minutes" | "project_id">>;

async function slotInput(task: Placeable, day: Date, now: Date, parts?: Part[]) {
  const [routine, busy, project] = await Promise.all([getRoutine(), busyAround(day, [task.id]), projectName(task.project_id)]);
  return { minutes: task.duration_minutes || estimateMinutes(task.title), kind: kindOf(task.title, project), day, now, routine, busy, parts };
}

/** A day he named without a time: one slot, or two or three to choose from, or none. */
export async function decideFor(task: Placeable, day: Date, now = new Date(), parts?: Part[]): Promise<Decision> {
  return decideSlot(await slotInput(task, day, now, parts));
}

/** Two or three real free slots on that day that fit his routine. */
export async function choicesFor(task: Placeable, day: Date, now = new Date()): Promise<Date[]> {
  return slotChoices(await slotInput(task, day, now));
}

/** The free time nearest `at` for this task (its own time if that is free). */
export async function nearestFreeFor(task: Placeable, at: Date, now = new Date()): Promise<Date | undefined> {
  return nearestFree({ ...(await slotInput(task, at, now)), at });
}

/** The time a button puts a task on that day: its own time of day if free, else what his routine says. */
export async function timeOnDay(task: Placeable & { due_at?: string | null }, day: Date, now = new Date()): Promise<{ at: Date; why?: string } | undefined> {
  if (task.due_at) {
    const minute = minuteOfDay(new Date(task.due_at));
    const same = new Date(localMidnight(day) + minute * 60_000);
    const free = await nearestFreeFor(task, same, now);
    return free ? { at: free } : undefined;
  }
  const decision = await decideFor(task, day, now);
  if (decision.decision === "propose") return { at: decision.at, why: decision.why };
  if (decision.decision === "ask") return { at: decision.options[0] };
  return undefined;
}
