/**
 * Subtasks: the pure rules (no database), tested in tests/subtasks.test.ts.
 */
export type Subtask = { id: number; task_id: number; title: string; done: boolean; position: number };

/** "0/3", "2/3": how far along a task's parts are. */
export function progress(subtasks: Pick<Subtask, "done">[]): string {
  return `${subtasks.filter((s) => s.done).length}/${subtasks.length}`;
}

/** True when the task has parts and every one is ticked (time to ask about the parent). */
export function allDone(subtasks: Pick<Subtask, "done">[]): boolean {
  return subtasks.length > 0 && subtasks.every((s) => s.done);
}

/**
 * A list written into a task's notes, as its parts and what is left of the
 * notes. Handles lines ("- slides", "• quiz", "2. examples") and inline
 * numbering ("Stories to cover: 1) the app, 2) the club, 3) the series.").
 * Fewer than two parts is not a list.
 */
export function listFromNotes(notes: string | null | undefined): { parts: string[]; rest: string } {
  const text = (notes ?? "").trim();
  if (!text) return { parts: [], rest: "" };
  const clean = (part: string) => part.replace(/^[\s,;:]+|[\s,;.]+$/g, "").replace(/^(and|&)\s+/i, "").trim();

  // One per line.
  const lines = text.split("\n");
  const marked = lines.filter((line) => /^\s*([-•*]|\d+[.)])\s+\S/.test(line));
  if (marked.length >= 2) {
    const parts = marked.map((line) => clean(line.replace(/^\s*([-•*]|\d+[.)])\s+/, ""))).filter(Boolean);
    const rest = lines.filter((line) => !marked.includes(line)).join("\n").trim().replace(/:\s*$/, "");
    return { parts, rest };
  }

  // Inline: "… 1) a, 2) b, 3) c."
  const inline = /(^|[\s:])1[.)]\s/.exec(text);
  if (inline) {
    const start = inline.index + inline[1].length;
    const pieces = text.slice(start).split(/(?:^|[\s,;])\d+[.)]\s+/).map(clean).filter(Boolean);
    if (pieces.length >= 2) return { parts: pieces, rest: text.slice(0, start).trim().replace(/:\s*$/, "") };
  }
  return { parts: [], rest: text };
}
