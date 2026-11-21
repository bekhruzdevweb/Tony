import "server-only";
import { requireDb } from "./db";
import { linksIn, mergeNotes } from "./brain/reliability";
import { wordsAround } from "./link-rules";
import { OPEN_STATUSES } from "./tasks";
import { describeUrl, isPromoCaption, itemLabel, libraryLine, pickItem, type LibraryItem } from "./library-rules";
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
export async function saveToLibrary(input: { kind: "link" | "post"; url?: string; title?: string | null; description?: string | null; source: string; taskId?: number; at?: string }): Promise<number | undefined> {
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
        // A real title replaces a stand-in ("YouTube video"); his words fill an empty description; a task he linked it to is kept.
        if (title && (!row.title || row.title === describeUrl(input.url)) && title !== row.title) better.title = title;
        if (input.description?.trim() && (!row.description || row.description === describeUrl(input.url))) better.description = input.description.trim().slice(0, 800);
        if (input.taskId && !row.task_id) better.task_id = input.taskId;
        if (Object.keys(better).length) await db.from("library").update(better).eq("id", row.id);
        return row.id;
      }
    }
    const { data, error } = await db
      .from("library")
      .insert({ kind: input.kind, url: input.url ?? null, title, description, source: input.source, task_id: input.taskId ?? null, ...(input.at ? { created_at: input.at } : {}) })
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
const fromMedia = (row: MediaRow): LibraryItem => ({ source: "media", id: row.id, kind: row.kind, title: row.note || (isPromoCaption(row.caption) ? null : row.caption), description: row.description, note: row.note, task_id: row.task_id, created_at: row.created_at });

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

/**
 * Links kept only in an open task's notes (from before the library existed)
 * join the library once, named by their task and dated by it, so every link
 * he means can be sent by reference.
 */
async function adoptTaskLinks(): Promise<void> {
  const db = requireDb();
  const { data } = await db.from("tasks").select("id, title, notes, created_at").in("status", OPEN_STATUSES).like("notes", "%http%").limit(100);
  const rows = (data ?? []) as { id: number; title: string; notes: string; created_at: string }[];
  if (rows.length === 0) return;
  const known = new Set((((await db.from("library").select("url").limit(2000)).data ?? []) as { url: string | null }[]).map((row) => row.url));
  for (const task of rows) {
    for (const url of linksIn(task.notes)) {
      if (known.has(url)) continue;
      await saveToLibrary({ kind: "link", url, title: task.title, description: wordsAround(task.notes), source: "task", taskId: task.id, at: task.created_at });
      known.add(url);
    }
  }
}

/**
 * His links and files for the brain, newest first, each with what he said
 * when he sent it and the task it belongs to, so "this video", "the reel I
 * have to shoot like" or "the masterclass" are picked by meaning, then sent
 * by code with library send (21 Nov: keyword matching mixed his links up).
 */
export async function libraryForPrompt(now = new Date(), links = 15, files = 12): Promise<string | undefined> {
  await adoptTaskLinks().catch((error) => console.warn("adoptTaskLinks:", error instanceof Error ? error.message : error));
  const items = await libraryItems(80).catch(() => [] as LibraryItem[]);
  // Files: an album kept with one task is one line ("+4 more with it"), and every file he named
  // ("ideas for my reels") is always listed (21 Nov 20:21: five album photos pushed his named video out
  // of the list, and Tony sent the wrong video twice).
  const media = items.filter((item) => item.source === "media" && item.kind !== "voice" && item.kind !== "audio");
  const perTask = new Map<number, number>();
  for (const item of media) if (item.task_id) perTask.set(item.task_id, (perTask.get(item.task_id) ?? 0) + 1);
  const seen = new Set<number>();
  const oneEach = media.filter((item) => {
    if (!item.task_id) return true;
    if (seen.has(item.task_id)) return false;
    seen.add(item.task_id);
    return true;
  });
  const named = oneEach.filter((item) => item.note?.trim());
  const fileList = [...new Map([...named, ...oneEach].map((item) => [item.id, item])).values()].slice(0, Math.max(files, named.length));
  const chosen = [...items.filter((item) => item.source === "library").slice(0, links), ...fileList].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (chosen.length === 0) return undefined;
  const ids = [...new Set(chosen.map((item) => item.task_id).filter((id): id is number => typeof id === "number"))];
  const tasks = ids.length ? (((await requireDb().from("tasks").select("id, title").in("id", ids)).data ?? []) as { id: number; title: string }[]) : [];
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  return chosen
    .map((item) => {
      const more = item.source === "media" && item.task_id ? (perTask.get(item.task_id) ?? 1) - 1 : 0;
      return `${libraryLine(item, now, item.task_id ? titles.get(item.task_id) : undefined)}${more > 0 ? ` · +${more} more with it` : ""}`;
    })
    .join("\n");
}

/**
 * /library: what he has saved, newest first, each under the label he gave it
 * ("ideas for my reels"), with a numbered button that sends it back. Voice
 * notes are left out (they are his messages, not saved things).
 */
export async function libraryView(now = new Date(), count = 20): Promise<{ text: string; rows: { text: string; data: string }[][] }> {
  const items = (await libraryItems(80).catch(() => [] as LibraryItem[])).filter((item) => item.kind !== "voice" && item.kind !== "audio").slice(0, count);
  if (items.length === 0) return { text: "Your library is empty, sir. Send me a link, a photo or a video and say what it is for.", rows: [] };
  const lines = items.map((item, index) => `${index + 1}. ${itemLabel(item, now)}`);
  const rows: { text: string; data: string }[][] = [];
  items.forEach((item, index) => {
    if (index % 5 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: `📤 ${index + 1}`, data: `lib:send:${item.source}:${item.id}` });
  });
  return { text: ["📚 **Your library**, newest first. Tap a number to get it back:", ...lines].join("\n"), rows };
}
