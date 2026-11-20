import "server-only";
import { requireDb } from "./db";
import {
  DEFAULT_ROUTINE,
  KINDS,
  KIND_LABEL,
  ROUTINE_FIELDS,
  decideSlot,
  kindOf,
  kindsFromWords,
  localMidnight,
  nearestFree,
  normalizeField,
  parseClockText,
  slotChoices,
  withSample,
  type Decision,
  type Interval,
  type Kind,
  type Part,
  type Routine,
  type RoutineField,
  type SlotOption,
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
  // Before migration 0023 the row has no auto_kinds: nothing is picked without asking.
  return { ...DEFAULT_ROUTINE, ...row, learned: (row.learned as Routine["learned"]) ?? {}, auto_kinds: Array.isArray(row.auto_kinds) ? row.auto_kinds : [] };
}

/**
 * "Decide yourself for podcasts" (on) or "ask me again for podcasts" (off):
 * the kinds Tony may pick a time for himself, read back. Plain words in, the
 * kinds he named out.
 */
export async function setAutoKinds(words: string, on: boolean): Promise<{ ok: true; kinds: Kind[]; label: string; on: boolean; all: Kind[] } | { ok: false; error: string }> {
  const kinds = kindsFromWords(words);
  if (kinds.length === 0) return { ok: false, error: `could not tell which kind of task "${words}" means: videos and podcasts, study, content, coding, workouts, errands, lesson prep or classes` };
  const routine = await getRoutine();
  const before = routine.auto_kinds ?? [];
  const next = on ? KINDS.filter((kind) => before.includes(kind) || kinds.includes(kind)) : before.filter((kind) => !kinds.includes(kind as Kind));
  const { error } = await requireDb().from("routine").update({ auto_kinds: next, updated_at: new Date().toISOString() }).eq("id", true);
  if (error) return { ok: false, error: "that setting could not be kept" };
  const stored = (await getRoutine()).auto_kinds ?? [];
  const kept = kinds.every((kind) => stored.includes(kind) === on);
  if (!kept) return { ok: false, error: "that setting could not be kept" };
  return { ok: true, kinds, label: kinds.map((kind) => KIND_LABEL[kind]).join(", "), on, all: stored as Kind[] };
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
 * He scheduled a task at a time of his own (typed it, tapped a slot, moved
 * it), or did it then: Tony learns that this kind of task belongs around that
 * time. Never fails the action it comes with.
 */
export async function recordSample(task: Pick<Task, "title"> & Partial<Pick<Task, "project_id" | "kind">>, at: Date): Promise<void> {
  if (task.kind === "prayer") return;
  try {
    const kind = kindOf(task.title, await projectName(task.project_id));
    const routine = await getRoutine();
    await requireDb()
      .from("routine")
      .update({ learned: withSample(routine.learned, kind, minuteOfDay(at)), updated_at: new Date().toISOString() })
      .eq("id", true);
  } catch (error) {
    console.error("recordSample failed:", error);
  }
}

/**
 * He finished a task: when he really did it (its start: the moment he ticked
 * it, less its length), learned like a time he chose. Only inside his waking
 * day; a tick at night says nothing about when he likes to do things.
 */
export async function recordDone(task: Pick<Task, "title"> & Partial<Pick<Task, "project_id" | "kind" | "duration_minutes">>, doneAt: Date): Promise<void> {
  if (task.kind === "prayer") return;
  const routine = await getRoutine();
  const started = new Date(doneAt.getTime() - (task.duration_minutes || 0) * 60_000);
  const minute = minuteOfDay(started);
  const wake = parseClockText(routine.wake) ?? 7 * 60;
  const sleep = parseClockText(routine.sleep) ?? 23 * 60;
  if (minute < wake || minute >= sleep) return;
  await recordSample(task, started);
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

/** A day he named without a time: asked (best first), Tony's own pick for a kind he let him decide, two halves, or none. */
export async function decideFor(task: Placeable, day: Date, now = new Date(), parts?: Part[]): Promise<Decision> {
  return decideSlot(await slotInput(task, day, now, parts));
}

/** Two or three real free slots on that day, best first, each with its reason. */
export async function choicesFor(task: Placeable, day: Date, now = new Date()): Promise<SlotOption[]> {
  return slotChoices(await slotInput(task, day, now));
}

/** The kind of task this is, for learning and for the time he types. */
export async function kindFor(task: Placeable): Promise<Kind> {
  return kindOf(task.title, await projectName(task.project_id));
}

/** The free time nearest `at` for this task (its own time if that is free). */
export async function nearestFreeFor(task: Placeable, at: Date, now = new Date()): Promise<Date | undefined> {
  return nearestFree({ ...(await slotInput(task, at, now)), at });
}

/**
 * The time a button puts a task with its own time on another day: the same
 * time of day if free, else the nearest free time. An undated task has no time
 * of its own: undefined, and he is asked instead (Change 1).
 */
export async function timeOnDay(task: Placeable & { due_at?: string | null }, day: Date, now = new Date()): Promise<{ at: Date } | undefined> {
  if (!task.due_at) return undefined;
  const minute = minuteOfDay(new Date(task.due_at));
  const same = new Date(localMidnight(day) + minute * 60_000);
  const free = await nearestFreeFor(task, same, now);
  return free ? { at: free } : undefined;
}
