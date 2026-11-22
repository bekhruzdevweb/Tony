import "server-only";
import { requireDb } from "./db";
import { linksIn, mergeNotes } from "./brain/reliability";
import { asksForLink, ownWords, wordsAround } from "./link-rules";
import { OPEN_STATUSES } from "./tasks";
import { describeUrl, groupAlbums, isPromoCaption, itemLabel, labelHit, labelMatch, libraryLine, pickItem, rankItems, refOf, type LibraryItem } from "./library-rules";
import { askedToSend, asksForMedia, updateMedia } from "./media";

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
export const itemRef = refOf;

/** He asks for something back: a photo, video, file or link, in any words with a send verb. */
export const asksForItem = (said: string) => asksForMedia(said) || asksForLink(said) || (askedToSend(said) && /\b(it|that|this|the one|one|them)\b/i.test(said));

/**
 * What Tony last sent him ("sent_item" events, within the last minutes): what
 * a "no, not this one" is about. "This one" is what answered his previous
 * message (or a tap after it): everything noted since that message. What he
 * got for an earlier request, and kept, is not rejected.
 */
export async function recentlySent(now = new Date(), minutes = 20): Promise<string[]> {
  const db = requireDb();
  const { data, error } = await db
    .from("events")
    .select("detail, created_at")
    .eq("kind", "sent_item")
    .gte("created_at", new Date(now.getTime() - minutes * 60_000).toISOString())
    .order("id", { ascending: false })
    .limit(6);
  if (error) return [];
  const rows = (data ?? []) as { detail: { ref?: unknown } | null; created_at: string }[];
  if (rows.length === 0) return [];
  const last = await db.from("messages").select("created_at").eq("role", "user").order("id", { ascending: false }).limit(1);
  const lastAt = ((last.data ?? []) as { created_at: string }[])[0]?.created_at;
  const latest = new Date(rows[0].created_at).getTime();
  const floor = lastAt ? new Date(lastAt).getTime() - 2_000 : latest - 10_000;
  const together = rows.filter((row) => new Date(row.created_at).getTime() >= floor);
  return [...new Set(together.map((row) => String(row.detail?.ref ?? "")).filter(Boolean))];
}

/**
 * The file or link he filed under the very words he uses now ("send me ideas
 * for my reels"): sent by code, no model (21 Nov 20:21: the model never saw it
 * and guessed twice). Two under one label: he is asked. What he just rejected
 * is never it.
 */
export async function findByLabel(said: string, exclude: string[] = []): Promise<{ found?: LibraryItem; choices?: LibraryItem[] }> {
  return labelMatch(groupAlbums(await libraryItems(300)), said, exclude);
}

/** The few items that fit his words best, for buttons when nothing was sent and nothing asked. */
export async function libraryCandidates(said: string, now = new Date(), exclude: string[] = []): Promise<LibraryItem[]> {
  return rankItems(groupAlbums(await libraryItems(300)), said, now, exclude);
}

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

/** Deletes an item for good, when he asks: a file with its private copy, or a link or post. Read back. */
export async function forgetItem(item: LibraryItem): Promise<boolean> {
  const db = requireDb();
  if (item.source === "media") {
    const found = await db.from("media").select("storage_path").eq("id", item.id).maybeSingle();
    const path = (found.data as { storage_path?: string | null } | null)?.storage_path;
    if (path) await db.storage.from("tony-media").remove([path]).catch(() => undefined);
    const { error } = await db.from("media").delete().eq("id", item.id);
    return !error;
  }
  const { error } = await db.from("library").delete().eq("id", item.id);
  return !error;
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
 *
 * Every file he labelled in the last two weeks is listed (his label is how he
 * asks for it), the photos of one forwarded post as one line, and when his
 * message asks for an item, the few that fit his words best come first
 * (21 Nov 20:21: the one he meant was cut off the list by an album, and the
 * model guessed). What he just rejected ("no, not this one") is left out.
 */
export async function libraryForPrompt(now = new Date(), options: { message?: string; rejected?: string[]; links?: number; files?: number } = {}): Promise<string | undefined> {
  const { links = 15, files = 30, rejected = [] } = options;
  await adoptTaskLinks().catch((error) => console.warn("adoptTaskLinks:", error instanceof Error ? error.message : error));
  const items = groupAlbums(await libraryItems(150).catch(() => [] as LibraryItem[]));
  const linkItems = items.filter((item) => item.source === "library").slice(0, links);
  const fileItems = items.filter((item) => item.source === "media" && item.kind !== "voice" && item.kind !== "audio");
  const fortnight = now.getTime() - 14 * 24 * 60 * 60_000;
  // A file he named: the label he filed it under, or a short caption of his own (a forwarded post's long text is not a name).
  const labelled = (item: LibraryItem) => Boolean(item.note?.trim()) || Boolean(item.title && item.title.length <= 60 && !item.album);
  const named = fileItems.filter((item) => labelled(item) && new Date(item.created_at).getTime() >= fortnight).slice(0, files);
  const unnamed = fileItems.filter((item) => !named.includes(item)).slice(0, 3);
  const newest = (a: LibraryItem, b: LibraryItem) => b.created_at.localeCompare(a.created_at);
  const chosen = [...linkItems, ...named, ...unnamed].filter((item) => !rejected.includes(refOf(item))).sort(newest);
  const said = options.message ? ownWords(options.message) : "";
  const candidates = said && (asksForItem(said) || rejected.length > 0) ? rankItems(items, said, now, rejected) : [];
  if (chosen.length === 0 && candidates.length === 0) return undefined;
  const ids = [...new Set([...chosen, ...candidates].map((item) => item.task_id).filter((id): id is number => typeof id === "number"))];
  const tasks = ids.length ? (((await requireDb().from("tasks").select("id, title").in("id", ids)).data ?? []) as { id: number; title: string }[]) : [];
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const line = (item: LibraryItem) => libraryLine(item, now, item.task_id ? titles.get(item.task_id) : undefined);
  const head = candidates.length
    ? [
        "Fits his words best (his own labels and what he said count most; pick by meaning, then library send):",
        ...candidates.map((item) => `${line(item)}${labelHit(item, said) ? " · HIS LABEL is in his words" : ""}`),
        "",
        "All of it, newest first:",
      ]
    : [];
  return [...head, ...chosen.map(line)].join("\n");
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
