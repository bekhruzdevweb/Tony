import "server-only";
import { chat, type ToolDefinition } from "./brain/model";
import { ownWords } from "./brain/reliability";
import { requireDb } from "./db";
import type { Row } from "./followups";
import { checkReview, DAY, LAYER_TITLES, normalNote, plainReview, reviewSummary, type MemoryLayer, type ReviewAction } from "./memory-rules";
import type { MemoryRow } from "./memory";
import { formatTime, localDate, TIMEZONE } from "./time";

/**
 * The Sunday memory review (22 Nov), on Sunday from 21:30 (memory-rules.ts has
 * the layers). Tony reads this week's and this month's notes against what he
 * said this week: what held moves up a layer, what went stale is dropped, the
 * rest is kept. He gets a three-line summary with ↩ to keep what was dropped.
 * Always notes are never touched here. If the model cannot be reached, the
 * plain rules decide. Every review is noted in `events` (kind memory_review),
 * with the dropped notes whole, so ↩ can put them back.
 */

type Dropped = Pick<MemoryRow, "fact" | "source" | "layer" | "goal" | "mentions" | "created_at">;
type ReviewDetail = {
  by: "model" | "rules";
  promoted: { id: number; fact: string; to: MemoryLayer }[];
  dropped: Dropped[];
  kept: number;
  restored?: string;
};

const REVIEW: ToolDefinition = {
  type: "function",
  function: {
    name: "review",
    description: "Say what happens to each note under review.",
    parameters: {
      type: "object",
      properties: {
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              action: { type: "string", enum: ["promote", "keep", "drop"] },
            },
            required: ["id", "action"],
          },
        },
      },
      required: ["notes"],
    },
  },
};

const SYSTEM = [
  "Once a week you tidy what you keep about Behruzbek, an English teacher and content creator in Uzbekistan.",
  "Notes live in three layers. This week: what is true now (this week's plans, focus and goals). This month: what has held for more than a week, and monthly goals. Always: who he is, his people, preferences and routine.",
  "For each note under review choose one action.",
  "promote: it has held and will keep holding (he came back to it, or it is plainly still in force). A week note goes to This month; a month note goes to Always only when it has become part of who he is or how he works.",
  "keep: still true, not settled yet.",
  "drop: done, past, replaced by something newer, or a week note he never came back to. Also drop a note that only repeats an Always note.",
  "Judge by his own words below and by the dates, never by guesses. A goal he is still working on is kept or promoted, not dropped.",
].join("\n");

const when = (at: string) => {
  const date = new Date(at);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" }).format(date);
  return `${day} ${formatTime(date)}`;
};

/** What he said this week in his own words (no forwarded posts, no photo text), newest kept first when it is long. */
function hisWeek(messages: { text: string; created_at: string }[], budget = 12_000): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const words = ownWords(message.text);
    if (!words) continue;
    const line = `- ${when(message.created_at)}: ${words.length > 300 ? `${words.slice(0, 299)}…` : words}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.reverse();
}

async function askModel(notes: MemoryRow[], said: string[], now: Date): Promise<ReviewAction[]> {
  const describe = (note: MemoryRow) => {
    const n = normalNote(note);
    return `- [${n.id}] ${LAYER_TITLES[n.layer]}${n.goal ? " · goal" : ""} · since ${when(n.created_at)} · last confirmed ${when(n.confirmed_at)} · came up ${n.mentions}×: ${n.fact}`;
  };
  const always = notes.filter((note) => normalNote(note).layer === "always");
  const reviewed = notes.filter((note) => normalNote(note).layer !== "always");
  const user = [
    `Now: ${when(now.toISOString())} (${localDate(now)}).`,
    `Always notes, for reference (not yours to change):\n${always.length ? always.map((note) => `- ${note.fact}`).join("\n") : "(none)"}`,
    `Notes to review:\n${reviewed.map(describe).join("\n")}`,
    `What he said this week, his own words, oldest first:\n${said.length ? said.join("\n") : "(nothing)"}`,
  ].join("\n\n");
  const answer = await chat({ system: SYSTEM, messages: [{ role: "user", content: user }], tools: [REVIEW], force: "review" });
  const call = answer.tool_calls?.find((entry) => entry.function.name === "review");
  if (!call) throw new Error("the model gave no review");
  const args = JSON.parse(call.function.arguments || "{}") as { notes?: { id?: unknown; action?: unknown }[] };
  return checkReview(reviewed, Array.isArray(args.notes) ? args.notes : [], now);
}

/**
 * Sunday's review: decided, applied, noted, and summed up. Undefined when
 * there is nothing to tell him (nothing learned, moved or dropped).
 */
export async function weeklyMemoryReview(now: Date): Promise<{ text: string; rows: Row[] } | undefined> {
  const db = requireDb();
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const [notesResult, messagesResult] = await Promise.all([
    db.from("memory").select("id, fact, source, layer, goal, mentions, confirmed_at, created_at").order("id"),
    db.from("messages").select("text, created_at").eq("role", "user").gte("created_at", weekAgo).order("id", { ascending: false }).limit(300),
  ]);
  if (notesResult.error) throw new Error(`weeklyMemoryReview: ${notesResult.error.message}`);
  const notes = (notesResult.data ?? []) as MemoryRow[];
  const said = hisWeek(((messagesResult.data ?? []) as { text: string; created_at: string }[]).reverse());
  const reviewed = notes.filter((note) => normalNote(note).layer !== "always");

  let by: ReviewDetail["by"] = "rules";
  let actions: ReviewAction[] = [];
  if (reviewed.length > 0) {
    try {
      actions = await askModel(notes, said, now);
      by = "model";
    } catch (error) {
      console.error("Memory review: the model could not help, the plain rules decide:", error);
      actions = plainReview(reviewed, now);
    }
  }

  // Applied one note at a time; a note changed since it was read (its layer moved) is left alone.
  const byId = new Map(notes.map((note) => [note.id, note]));
  const promoted: ReviewDetail["promoted"] = [];
  const dropped: Dropped[] = [];
  let kept = 0;
  for (const action of actions) {
    const note = byId.get(action.id);
    if (!note) continue;
    const layer = normalNote(note).layer;
    if (action.action === "promote" && action.to) {
      const { data } = await db.from("memory").update({ layer: action.to, confirmed_at: now.toISOString() }).eq("id", note.id).eq("layer", layer).select("id");
      if ((data ?? []).length) promoted.push({ id: note.id, fact: note.fact, to: action.to });
    } else if (action.action === "drop") {
      const { data } = await db.from("memory").delete().eq("id", note.id).eq("layer", layer).select("fact, source, layer, goal, mentions, created_at");
      dropped.push(...((data ?? []) as Dropped[]));
    } else if (action.action === "keep") {
      // Kept on purpose: the review has just confirmed it, so it does not fade this week.
      const { data } = await db.from("memory").update({ confirmed_at: now.toISOString() }).eq("id", note.id).eq("layer", layer).select("id");
      kept += (data ?? []).length;
    }
  }

  // Each note in one line at most: what was new this week and stays where it is, what moved up, what went.
  const droppedFacts = new Set(dropped.map((note) => note.fact));
  const promotedIds = new Set(promoted.map((note) => note.id));
  const learned = notes
    .filter((note) => new Date(note.created_at).getTime() >= now.getTime() - 7 * DAY && !droppedFacts.has(note.fact) && !promotedIds.has(note.id))
    .reverse()
    .map((note) => note.fact);
  const detail: ReviewDetail = { by, promoted, dropped, kept };
  const logged = await db.from("events").insert({ kind: "memory_review", detail }).select("id").single();
  const eventId = (logged.data as { id: number } | null)?.id;

  const text = reviewSummary({ learned, promoted, dropped: dropped.map((note) => note.fact) });
  if (!text) return undefined;
  const row = [
    ...(dropped.length && eventId !== undefined ? [{ text: "↩ Keep the dropped", data: `mr:undo:${eventId}` }] : []),
    { text: "🧠 See memory", data: "mr:view" },
  ];
  return { text, rows: [row] };
}

/** ↩ under the Sunday summary: what it dropped goes back, confirmed now, once. Plain code. */
export async function keepDropped(eventId: number, now: Date): Promise<string> {
  const db = requireDb();
  const { data } = await db.from("events").select("id, detail").eq("id", eventId).eq("kind", "memory_review").maybeSingle();
  const detail = (data as { detail: ReviewDetail } | null)?.detail;
  if (!detail) return "That review is gone, sir.";
  if (detail.restored) return "Those are already back, sir.";
  const back: Record<string, unknown>[] = [];
  for (const note of detail.dropped ?? []) {
    // Said again since (the same words are back): nothing to add.
    const known = await db.from("memory").select("id").ilike("fact", note.fact.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(1);
    if ((known.data ?? []).length) continue;
    back.push({ fact: note.fact, source: note.source ?? "user", layer: note.layer, goal: note.goal, mentions: note.mentions, created_at: note.created_at, confirmed_at: now.toISOString() });
  }
  if (back.length) {
    const { error } = await db.from("memory").insert(back);
    if (error) throw new Error(`keepDropped: ${error.message}`);
  }
  await db.from("events").update({ detail: { ...detail, restored: now.toISOString() } }).eq("id", eventId);
  if (back.length === 0) return "Those are already back, sir.";
  return back.length === 1 ? `↩ Kept, sir: ${String(back[0].fact)}` : `↩ Kept all ${back.length}, sir.`;
}
