import "server-only";
import { requireDb } from "./db";
import { mergeNotes } from "./brain/reliability";
import { describeUrl, itemLabel, pickItem, type LibraryItem } from "./library-rules";
import { updateMedia } from "./media";

/**
 * The library (phase b, 21 Nov): every link and forwarded post he sends,
 * kept with what it is, next to the photos, videos, files and voice notes
 * kept in media. Found again by what he calls it, attached to a task, sent
 * back. Before migration 0024 the library table is missing: links are then
 * not kept, and nothing else changes.
 */

type LibraryRow = { id: number; kind: "link" | "post"; url: string | null; title: string | null; description: string | null; source: string | null; task_id: number | null; created_at: string };
type MediaRow = { id: number; kind: string; caption: string | null; description: string | null; note: string | null; task_id: number | null; created_at: string };

/** Keeps a link or a post; the same link twice is one item (its title filled in if it was missing). Never fails the message. */
export async function saveToLibrary(input: { kind: "link" | "post"; url?: string; title?: string | null; description?: string | null; source: string; taskId?: number }): Promise<number | undefined> {
  try {
    const db = requireDb();
    const title = input.title?.trim().slice(0, 200) || (input.url ? describeUrl(input.url) : null);
    const description = input.description?.trim().slice(0, 800) || (input.url ? describeUrl(input.url) : null);
    if (input.url) {
      const known = await db.from("library").select().eq("url", input.url).order("id", { ascending: false }).limit(1);
      if (known.error) throw new Error(known.error.message);
      const row = ((known.data ?? []) as LibraryRow[])[0];
      if (row) {
        const better: Partial<LibraryRow> = {};
        // A real title replaces a stand-in ("YouTube video"); a task he linked it to is kept.
        if (title && (!row.title || row.title === describeUrl(input.url)) && title !== row.title) better.title = title;
        if (input.taskId && !row.task_id) better.task_id = input.taskId;
        if (Object.keys(better).length) await db.from("library").update(better).eq("id", row.id);
        return row.id;
      }
    }
    const { data, error } = await db
      .from("library")
      .insert({ kind: input.kind, url: input.url ?? null, title, description, source: input.source, task_id: input.taskId ?? null })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return (data as { id: number }).id;
  } catch (error) {
    console.warn("saveToLibrary:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

const fromLibrary = (row: LibraryRow): LibraryItem => ({ source: "library", id: row.id, kind: row.kind, url: row.url, title: row.title, description: row.description, task_id: row.task_id, created_at: row.created_at });
const fromMedia = (row: MediaRow): LibraryItem => ({ source: "media", id: row.id, kind: row.kind, title: row.caption, description: row.description, note: row.note, task_id: row.task_id, created_at: row.created_at });

/** Everything in the library, newest first: links and posts, and the files kept in media. */
export async function libraryItems(limit = 300): Promise<LibraryItem[]> {
  const db = requireDb();
  const [links, files] = await Promise.all([
    db.from("library").select().order("created_at", { ascending: false }).limit(limit),
    db.from("media").select("id, kind, caption, description, note, task_id, created_at").order("created_at", { ascending: false }).limit(limit),
  ]);
  const items = [...(links.error ? [] : ((links.data ?? []) as LibraryRow[]).map(fromLibrary)), ...(files.error ? [] : ((files.data ?? []) as MediaRow[]).map(fromMedia))];
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The item he means ("that Instagram video", "the photo I sent yesterday"), or the few that fit equally well. */
export async function findInLibrary(query: string, now = new Date()): Promise<{ found?: LibraryItem; choices?: LibraryItem[] }> {
  return pickItem(await libraryItems(), query, now);
}

/** "library:3", "media:7": how an item is named on a button and to the brain. */
export const itemRef = (item: Pick<LibraryItem, "source" | "id">) => `${item.source}:${item.id}`;

export async function loadItem(ref: string): Promise<LibraryItem | undefined> {
  const [source, id] = ref.split(":");
  const db = requireDb();
  if (source === "library") {
    const { data } = await db.from("library").select().eq("id", Number(id)).maybeSingle();
    return data ? fromLibrary(data as LibraryRow) : undefined;
  }
  if (source === "media") {
    const { data } = await db.from("media").select("id, kind, caption, description, note, task_id, created_at").eq("id", Number(id)).maybeSingle();
    return data ? fromMedia(data as MediaRow) : undefined;
  }
  return undefined;
}

/**
 * Attaches an item to a task, read back: a file is linked to it (its
 * reminder sends the original), a link or post goes into its notes.
 */
export async function attachItem(item: LibraryItem, taskId: number): Promise<boolean> {
  const db = requireDb();
  if (item.source === "media") {
    await updateMedia(item.id, { task_id: taskId });
    const back = await db.from("media").select("task_id").eq("id", item.id).maybeSingle();
    return Number((back.data as { task_id?: unknown } | null)?.task_id) === taskId;
  }
  const task = (await db.from("tasks").select("notes").eq("id", taskId).maybeSingle()).data as { notes: string | null } | null;
  if (!task) return false;
  const piece = item.url ?? [item.title, item.description].filter(Boolean).join(": ");
  if (!piece) return false;
  const notes = mergeNotes(task.notes, piece);
  if (notes !== task.notes) await db.from("tasks").update({ notes }).eq("id", taskId);
  await db.from("library").update({ task_id: taskId }).eq("id", item.id);
  const back = (await db.from("tasks").select("notes").eq("id", taskId).maybeSingle()).data as { notes: string | null } | null;
  return Boolean(back?.notes?.includes(piece));
}

/** The newest few items, one line each, for the brain to know what "that video" may be. */
export async function libraryForPrompt(now = new Date(), count = 6): Promise<string | undefined> {
  const items = (await libraryItems(count).catch(() => [])).slice(0, count);
  if (items.length === 0) return undefined;
  return items.map((item) => `${itemRef(item)} ${itemLabel(item, now)}${item.url ? ` ${item.url}` : ""}`).join("\n");
}
