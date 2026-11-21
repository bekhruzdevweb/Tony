import "server-only";
import { titleFrom } from "./brain/checks";
import { linksIn } from "./brain/reliability";
import { requireDb } from "./db";
import { rankLinks, type LinkCandidate } from "./link-rules";
import type { StoredMessage } from "./messages";
import { OPEN_STATUSES } from "./tasks";

const MINUTE = 60_000;

/** A page's title, fetched quickly; a readable stand-in from the address if the page will not say. */
export async function fetchTitle(url: string, timeoutMs = 6_000): Promise<string> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TonyBot/1.0)", Accept: "text/html" },
    });
    const html = response.ok ? (await response.text()).slice(0, 200_000) : "";
    return titleFrom(html, url);
  } catch {
    return titleFrom("", url);
  }
}

/** The title Tony already knows for a link (from summing it up when he sent it), or the page's own. */
export async function pageTitle(url: string): Promise<string> {
  const { data } = await requireDb().from("offers").select("payload").eq("kind", "link").order("id", { ascending: false }).limit(20);
  const known = ((data ?? []) as { payload: { url?: string; title?: string } }[]).find((row) => row.payload?.url === url)?.payload.title;
  return known ?? fetchTitle(url, 3_000);
}

/**
 * A link he sent recently, newest first, with the title Tony learned for it.
 * `lastOnly`: only his message right before this one (the "link, then the
 * task" case), and only a link no open task holds yet.
 */
export async function recentLink(now: Date, history: StoredMessage[], options: { minutes?: number; lastOnly?: boolean } = {}): Promise<{ url: string; title?: string } | undefined> {
  const db = requireDb();
  const since = now.getTime() - (options.minutes ?? 30) * MINUTE;
  const his = history.filter((message) => message.role === "user" && new Date(message.created_at).getTime() >= since);
  const pool = options.lastOnly ? his.slice(-1) : his;
  for (const message of [...pool].reverse()) {
    for (const url of linksIn(message.text).reverse()) {
      if (options.lastOnly) {
        // A link already kept in a task belongs to that task.
        const used = await db.from("tasks").select("id").in("status", OPEN_STATUSES).like("notes", `%${url}%`).limit(1);
        if ((used.data ?? []).length > 0) continue;
      }
      const offers = await db.from("offers").select("payload").eq("kind", "link").order("id", { ascending: false }).limit(20);
      const title = ((offers.data ?? []) as { payload: { url?: string; title?: string } }[]).find((row) => row.payload?.url === url)?.payload.title;
      return { url, ...(title ? { title } : {}) };
    }
  }
  return undefined;
}

/** Every link he could mean by "send me the video": tasks' notes, bookmarks, links he summed up, his recent messages. */
export async function linkCandidates(now: Date): Promise<LinkCandidate[]> {
  const db = requireDb();
  const week = new Date(now.getTime() - 7 * 24 * 60 * MINUTE).toISOString();
  const [tasks, done, memory, offers, messages] = await Promise.all([
    db.from("tasks").select("title, notes, updated_at").in("status", OPEN_STATUSES).like("notes", "%http%").limit(100),
    db.from("tasks").select("title, notes, updated_at").eq("status", "done").gte("updated_at", week).like("notes", "%http%").limit(50),
    db.from("memory").select("fact, created_at").like("fact", "Saved link:%").limit(100),
    db.from("offers").select("payload, created_at").eq("kind", "link").gte("created_at", week).limit(50),
    db.from("messages").select("text, created_at").eq("role", "user").gte("created_at", new Date(now.getTime() - 3 * 24 * 60 * MINUTE).toISOString()).like("text", "%http%").limit(50),
  ]);
  const out: LinkCandidate[] = [];
  for (const row of [...((tasks.data ?? []) as { title: string; notes: string; updated_at: string }[]), ...((done.data ?? []) as { title: string; notes: string; updated_at: string }[])]) {
    for (const url of linksIn(row.notes)) out.push({ url, title: row.title, context: row.notes.replace(url, " "), at: new Date(row.updated_at).getTime() });
  }
  for (const row of (memory.data ?? []) as { fact: string; created_at: string }[]) {
    const match = /^Saved link: (.*) \((https?:\/\/\S+)\)$/.exec(row.fact);
    if (match) out.push({ url: match[2], title: match[1], context: "", at: new Date(row.created_at).getTime() });
  }
  for (const row of (offers.data ?? []) as { payload: { url?: string; title?: string; summary?: string }; created_at: string }[]) {
    if (row.payload?.url) out.push({ url: row.payload.url, title: row.payload.title ?? "", context: row.payload.summary ?? "", at: new Date(row.created_at).getTime() });
  }
  for (const row of (messages.data ?? []) as { text: string; created_at: string }[]) {
    for (const url of linksIn(row.text)) out.push({ url, title: "", context: row.text.replace(url, " "), at: new Date(row.created_at).getTime() });
  }
  return out;
}

/**
 * "Send me the video": the link itself, at once, in plain code. The best
 * match; two if it is a close call. Undefined if he has sent no links.
 */
export async function linkReply(request: string, now = new Date()): Promise<string | undefined> {
  // Tony's last few messages in the past hour, newest first.
  const said = await requireDb().from("messages").select("text").eq("role", "tony").gte("created_at", new Date(now.getTime() - 60 * MINUTE).toISOString()).order("created_at", { ascending: false }).limit(4);
  const ranked = rankLinks(request, await linkCandidates(now), ((said.data ?? []) as { text: string }[]).map((row) => row.text));
  if (ranked.length === 0) return undefined;
  const [best, second] = ranked;
  const line = (item: LinkCandidate) => `🔗 ${item.title ? `**${item.title}**\n` : ""}${item.url}`;
  // A close call (same score, both matching words he used): both, newest first.
  const close = second !== undefined && second.points === best.points && best.words > 0 && second.words > 0;
  return close ? `${line(best)}\n\n${line(second)}` : line(best);
}
