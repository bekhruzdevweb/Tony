/**
 * Layered memory (22 Nov), pure rules: no database, no model.
 *
 * - week: what is true now: this week's plans, focus and goals ("IELTS prep is
 *   the priority"). It fades after a week unless it comes up again.
 * - month: what held for more than a week, and monthly goals.
 * - always: who he is, his people, preferences, routine, how he wants Tony to work.
 *
 * The Sunday review (memory-review.ts) moves what held up a layer and drops
 * what went stale; these rules are its fallback when the model cannot be reached,
 * and they decide what is shown in every reply.
 */

export type MemoryLayer = "week" | "month" | "always";

export type MemoryNote = {
  id: number;
  fact: string;
  layer: MemoryLayer;
  goal: boolean;
  mentions: number;
  confirmed_at: string;
  created_at: string;
};

export const LAYERS: MemoryLayer[] = ["always", "month", "week"];

export const DAY = 24 * 60 * 60_000;
/** A week note not confirmed for this long has faded. */
export const WEEK_LIFE = 7 * DAY;
/** A month note not confirmed for this long has faded. */
export const MONTH_LIFE = 31 * DAY;

export const LAYER_TITLES: Record<MemoryLayer, string> = { always: "Always", month: "This month", week: "This week" };

/** A layer he or the model named, read leniently ("weekly", "monthly", "permanent"). */
export function readLayer(value: unknown): MemoryLayer {
  const text = String(value ?? "").toLowerCase();
  if (/week/.test(text)) return "week";
  if (/month/.test(text)) return "month";
  return "always";
}

/** Higher layers outrank lower ones: a note is never moved down by being repeated. */
export function higherLayer(a: MemoryLayer, b: MemoryLayer): MemoryLayer {
  return LAYERS.indexOf(a) <= LAYERS.indexOf(b) ? a : b;
}

/** A note read leniently: older rows (and tests) may lack a layer or a confirmation time. */
export function normalNote(note: Partial<MemoryNote> & { id: number; fact: string }): MemoryNote {
  const created = note.created_at ?? note.confirmed_at ?? new Date(0).toISOString();
  return {
    id: note.id,
    fact: note.fact,
    layer: note.layer === "week" || note.layer === "month" ? note.layer : "always",
    goal: note.goal === true,
    mentions: typeof note.mentions === "number" && note.mentions > 0 ? note.mentions : 1,
    confirmed_at: note.confirmed_at ?? created,
    created_at: created,
  };
}

/** Whether a note is still alive (always notes never fade on their own). */
export function isAlive(note: MemoryNote, now: Date): boolean {
  if (note.layer === "always") return true;
  const age = now.getTime() - new Date(note.confirmed_at).getTime();
  if (note.layer === "week") return age <= WEEK_LIFE;
  if (note.layer === "month") return age <= MONTH_LIFE;
  return true;
}

export type ReviewAction = { id: number; action: "promote" | "drop" | "keep"; to?: MemoryLayer };

/**
 * What the Sunday review does when the model cannot help: a week note that came
 * up again moves to this month, one that did not fades; a month note that kept
 * coming up for a month moves to always, one not heard of in a month fades.
 * Always notes are his to change (in /memory), never touched here.
 */
export function plainReview(raw: (Partial<MemoryNote> & { id: number; fact: string })[], now: Date): ReviewAction[] {
  const actions: ReviewAction[] = [];
  for (const note of raw.map(normalNote)) {
    const age = now.getTime() - new Date(note.created_at).getTime();
    if (note.layer === "week") {
      if (note.mentions >= 2 && age >= 5 * DAY) actions.push({ id: note.id, action: "promote", to: "month" });
      else if (!isAlive(note, now)) actions.push({ id: note.id, action: "drop" });
    } else if (note.layer === "month") {
      if (note.mentions >= 3 && age >= 28 * DAY) actions.push({ id: note.id, action: "promote", to: "always" });
      else if (!isAlive(note, now)) actions.push({ id: note.id, action: "drop" });
    }
  }
  return actions;
}

/** The layer above each one: a note moves up one step at a time. */
const NEXT: Record<MemoryLayer, MemoryLayer | undefined> = { week: "month", month: "always", always: undefined };

/**
 * The rails on what the model proposes in the Sunday review. Only this week's
 * and this month's notes are reviewed (always notes are his to change), each
 * once. A note moves up one layer, and only once it has had time to hold: three
 * days for a week note, three weeks for a month note; before that it is kept.
 * Nothing confirmed in the last day is dropped. A note the model passed over is
 * left to the plain rules (a faded one goes, one that came up again moves up).
 */
export function checkReview(
  raw: (Partial<MemoryNote> & { id: number; fact: string })[],
  proposed: { id?: unknown; action?: unknown }[],
  now: Date,
): ReviewAction[] {
  const notes = new Map(
    raw
      .map(normalNote)
      .filter((note) => note.layer !== "always")
      .map((note) => [note.id, note]),
  );
  const decided = new Map<number, ReviewAction>();
  for (const entry of proposed) {
    const id = Number(entry.id);
    const note = notes.get(id);
    if (!note || decided.has(id)) continue;
    const action = String(entry.action ?? "").toLowerCase();
    const age = now.getTime() - new Date(note.created_at).getTime();
    const fresh = now.getTime() - new Date(note.confirmed_at).getTime() < DAY;
    if (action === "promote") {
      const held = note.layer === "week" ? age >= 3 * DAY : age >= 21 * DAY;
      decided.set(id, held ? { id, action: "promote", to: NEXT[note.layer] } : { id, action: "keep" });
    } else if (action === "drop") {
      decided.set(id, fresh ? { id, action: "keep" } : { id, action: "drop" });
    } else if (action === "keep") {
      decided.set(id, { id, action: "keep" });
    }
  }
  const passedOver = [...notes.values()].filter((note) => !decided.has(note.id));
  return [...decided.values(), ...plainReview(passedOver, now)];
}

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const listOf = (items: string[], max = 3) => [...items.slice(0, max), ...(items.length > max ? [`+${items.length - max} more`] : [])].join(" · ");

/**
 * The Sunday summary, at most three lines under its title: what Tony learned
 * this week, what moved up a layer, what was dropped. Nothing to say, no message.
 */
export function reviewSummary(input: { learned: string[]; promoted: { fact: string; to: MemoryLayer }[]; dropped: string[] }): string | undefined {
  const lines: string[] = [];
  if (input.learned.length) lines.push(`📝 **Learned** (${input.learned.length}): ${listOf(input.learned.map((fact) => short(fact, 60)))}`);
  if (input.promoted.length) lines.push(`⬆️ **Moved up**: ${listOf(input.promoted.map((note) => `${short(note.fact, 50)} → ${LAYER_TITLES[note.to]}`))}`);
  if (input.dropped.length) lines.push(`🗑 **Dropped**: ${listOf(input.dropped.map((fact) => short(fact, 60)))}`);
  if (lines.length === 0) return undefined;
  return ["🧠 **Sunday memory review**, sir.", ...lines].join("\n");
}

/**
 * /memory, grouped by layer (this week, this month, always). Numbers run on
 * across the layers so each 🗑 matches its line; goals are marked 🎯 and notes
 * past their life "fading" (the Sunday review drops them). At most `cap` notes:
 * every week and month note, then the newest always notes.
 */
export function memoryPage(
  raw: (Partial<MemoryNote> & { id: number; fact: string; source?: string | null })[],
  now: Date,
  cap = 30,
): { lines: string[]; ids: number[]; hidden: number } {
  const notes = raw.map((row) => ({ ...normalNote(row), source: row.source ?? null }));
  const inLayer = (layer: MemoryLayer) => notes.filter((note) => note.layer === layer);
  const week = inLayer("week");
  const month = inLayer("month");
  const always = inLayer("always");
  const room = Math.max(0, cap - week.length - month.length);
  const shown: [MemoryLayer, typeof notes][] = [
    ["week", week],
    ["month", month],
    ["always", room > 0 ? always.slice(-room) : []],
  ];
  const lines: string[] = [];
  const ids: number[] = [];
  for (const [layer, list] of shown) {
    if (list.length === 0) continue;
    lines.push("", `**${LAYER_TITLES[layer]}**`);
    for (const note of list) {
      ids.push(note.id);
      const fading = !isAlive(note, now);
      lines.push(`${ids.length}. ${note.goal ? "🎯 " : ""}${note.source === "link" ? "🔗 " : ""}${short(note.fact, 140)}${fading ? " · _fading_" : ""}`);
    }
  }
  return { lines, ids, hidden: always.length - (room > 0 ? Math.min(room, always.length) : 0) };
}

/**
 * Memory as the brain sees it in every reply: grouped by layer, goals marked 🎯,
 * faded notes left out. Always notes may be many, so the ones that bear on his
 * message come first (the caller has chosen them); month and week are few.
 */
export function memoryBlock(raw: (Partial<MemoryNote> & { id: number; fact: string })[], now: Date): string {
  const alive = raw.map(normalNote).filter((note) => isAlive(note, now));
  if (alive.length === 0) return "(none yet)";
  const blocks = LAYERS.flatMap((layer) => {
    const inLayer = alive.filter((note) => note.layer === layer);
    if (inLayer.length === 0) return [];
    return [`${LAYER_TITLES[layer]}:`, ...inLayer.map((note) => `[${note.id}] ${note.goal ? "🎯 " : ""}${note.fact}`)];
  });
  return blocks.join("\n");
}

/** This week's and this month's goals, newest first: what plans and the morning brief put first. */
export function currentGoals(raw: (Partial<MemoryNote> & { id: number; fact: string })[], now: Date): MemoryNote[] {
  return raw
    .map(normalNote)
    .filter((note) => note.goal && note.layer !== "always" && isAlive(note, now))
    .sort((a, b) => LAYERS.indexOf(b.layer) - LAYERS.indexOf(a.layer) || b.confirmed_at.localeCompare(a.confirmed_at));
}
