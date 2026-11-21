/**
 * The library: everything he sends (links, posts, photos, videos, files,
 * voice notes), found again by what he calls it: "that Instagram video",
 * "the photo I sent yesterday". Pure ranking, no database; tested in
 * tests/library.test.ts.
 */
import { hisDate, localDate, TIMEZONE } from "./time";

export type LibraryItem = {
  /** Where it lives: the library table (links, posts) or media (files Telegram keeps). */
  source: "library" | "media";
  id: number;
  /** link, post, photo, video, document, voice, audio, animation */
  kind: string;
  title: string | null;
  description: string | null;
  url?: string | null;
  note?: string | null;
  task_id?: number | null;
  created_at: string;
  /** The photos of one forwarded post, shown as one item: how many there are. */
  album?: number;
};

const DAY_MS = 24 * 60 * 60_000;

/** Words that say nothing about which item he means. */
const STOP = new Set(
  "send sent give show find that this those these which what where when there here with from about have please could would just again tony thing things item items link links video videos photo photos picture pictures image images post posts file files voice note notes message yesterday today tonight morning evening week last earlier before sent ago days attach attached task tasks open watch the and for not one other ones you your our his her its all any can are was were but how why who did does has had get got want need some like into onto mean meant".split(
    " ",
  ),
);

const stems = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP.has(word)).map((word) => word.slice(0, 5)));

/** "library:3", "media:7": how an item is named on a button and to the brain. */
export const refOf = (item: Pick<LibraryItem, "source" | "id">) => `${item.source}:${item.id}`;

// ── His own label is the key (21 Nov 20:21) ─────────────────────────────
// He filed a video under "ideas for my reels" and asked for "ideas for my
// reels"; the model never saw it and guessed twice. A label he gave, found
// whole in his words, settles it in code: no model, no guess.

/** Words that carry no meaning in a label or in a request for one. */
const FILLER = new Set([...STOP, "didn", "don"]);
const labelWords = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !FILLER.has(word)).map((word) => word.slice(0, 5)));

/** His own name for an item: the label he filed it under or his caption (a file), what he said with it (a link). A page's title is not his. */
export function labelOf(item: LibraryItem): string | undefined {
  if (item.source === "media") return item.title?.trim() || undefined;
  const said = item.description?.trim();
  return said && said !== describeUrl(item.url ?? "") && said !== item.title ? said : undefined;
}

/** Whether his words hold the item's whole label: two or more of its words, or its one distinctive word ("motivation"). */
export function labelHit(item: LibraryItem, said: string): boolean {
  const label = labelWords(labelOf(item) ?? "");
  if (label.size === 0) return false;
  const his = labelWords(said);
  if (label.size === 1) return [...label].every((word) => word.length >= 5 && his.has(word));
  return [...label].every((word) => his.has(word));
}

/** The item he filed under the words he uses now, or the few under one label (he is asked), or nothing. Never a voice note. */
export function labelMatch(items: LibraryItem[], said: string, exclude: string[] = []): { found?: LibraryItem; choices?: LibraryItem[] } {
  const hits = items
    .filter((item) => !exclude.includes(refOf(item)) && item.kind !== "voice" && item.kind !== "audio" && labelHit(item, said))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (hits.length === 0) return {};
  if (hits.length === 1) return { found: hits[0] };
  return { choices: hits.slice(0, 3) };
}

/** "No, I didn't mean this one", "I meant the other video", "wrong one", "that's not it": what was just sent is not what he wanted. */
export const isNotThatOne = (text: string) =>
  /\b(no|nope|nah|not)\b[^.?!]{0,40}\b(this|that|the) one\b/i.test(text) ||
  /\b(didn'?t|did not|don'?t|do not|never) mean\b/i.test(text) ||
  /\bi meant\b/i.test(text) ||
  /\bwrong (one|video|link|photo|picture|file|reel|post|item)\b/i.test(text) ||
  /\b(that|this|it)('?s| is)? not (it|the one|right)\b/i.test(text) ||
  /^\s*(no|nope|nah)[,.!]?\s+(not|that'?s not|this is not|it'?s not)\b/i.test(text);

/** The few items that fit his words best, his own label counting most; what he rejected left out. For the brain to choose from, or for buttons. */
export function rankItems(items: LibraryItem[], said: string, now: Date, exclude: string[] = [], count = 3): LibraryItem[] {
  return items
    .filter((item) => !exclude.includes(refOf(item)) && item.kind !== "voice" && item.kind !== "audio")
    .map((item) => ({ item, score: scoreItem(item, said, now) + (labelHit(item, said) ? 4 : 0) }))
    .filter((entry) => entry.score >= MATCH)
    .sort((a, b) => b.score - a.score || b.item.created_at.localeCompare(a.item.created_at))
    .slice(0, count)
    .map((entry) => entry.item);
}

/**
 * The photos (or videos) of one forwarded post, kept as separate files, are
 * one item here: the first stands for all, with `album` saying how many.
 * Files with labels of their own stay apart.
 */
export function groupAlbums(items: LibraryItem[]): LibraryItem[] {
  const key = (item: LibraryItem) => (item.source === "media" && (item.kind === "photo" || item.kind === "video") ? `${item.task_id ?? "-"}|${item.created_at.slice(0, 16)}` : undefined);
  const groups = new Map<string, LibraryItem[]>();
  for (const item of items) {
    const k = key(item);
    if (k) groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  const seen = new Set<string>();
  const out: LibraryItem[] = [];
  for (const item of items) {
    const k = key(item);
    const members = k ? groups.get(k) ?? [] : [];
    const titles = new Set(members.map((member) => member.title?.trim()).filter(Boolean));
    if (members.length < 2 || titles.size > 1) {
      out.push(item);
      continue;
    }
    if (seen.has(k!)) continue;
    seen.add(k!);
    out.push({ ...item, title: item.title ?? [...titles][0] ?? null, album: members.length });
  }
  return out;
}

/**
 * A caption a downloader bot stamps on what it hands out ("Спасибо, что
 * пользуетесь - @SaveAsBot'ом", "Downloaded via @..."): not a name for the item.
 */
export function isPromoCaption(caption: string | null | undefined): boolean {
  if (!caption?.trim()) return false;
  const text = caption.replace(/[\u200b-\u200d\ufeff]/g, "").trim();
  return text.length <= 120 && /(спасибо,?\s+что\s+пользуетесь|thanks?\s+for\s+using|downloaded\s+(with|via|by|from|using)|скачан[оа]?\s+(с|через|в)|saved\s+(with|via|by)|@\w*bot\b)/i.test(text);
}

/** The site an item comes from, as he would name it. */
export function siteOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (/youtu\.?be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/t\.me\//i.test(url)) return "telegram";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** What he asks for: a kind of thing, a site, a day. */
export function wantedOf(query: string, now: Date): { kinds: string[]; site?: string; day?: { from: number; to: number } } {
  const t = query.toLowerCase();
  const kinds: string[] = [];
  if (/\b(videos?|reels?|clips?)\b/.test(t)) kinds.push("video");
  if (/\b(photos?|pictures?|pics?|images?|screenshots?)\b/.test(t)) kinds.push("photo");
  if (/\b(links?|urls?|websites?|pages?|articles?)\b/.test(t)) kinds.push("link");
  if (/\bposts?\b/.test(t)) kinds.push("post");
  if (/\b(voice ?notes?|voice messages?|audio|recordings?)\b/.test(t)) kinds.push("voice");
  if (/\b(files?|pdfs?|documents?|docs?)\b/.test(t)) kinds.push("document");
  const site = /\b(instagram|insta|ig)\b/.test(t) ? "instagram" : /\b(youtube|yt)\b/.test(t) ? "youtube" : /\btiktok\b/.test(t) ? "tiktok" : undefined;
  // The day he names, by the day he lives (after midnight, "yesterday" is still the day before he slept).
  const start = (date: string) => new Date(`${date}T00:00:00+05:00`).getTime();
  const today = hisDate(now, TIMEZONE);
  let day: { from: number; to: number } | undefined;
  if (/\byesterday\b/.test(t)) day = { from: start(today) - DAY_MS, to: start(today) };
  else if (/\b(today|this morning|earlier today)\b/.test(t)) day = { from: start(today), to: start(today) + DAY_MS + 5 * 60 * 60_000 };
  else if (/\b(last week|this week|few days ago|the other day)\b/.test(t)) day = { from: start(today) - 7 * DAY_MS, to: now.getTime() };
  else {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const named = names.findIndex((name) => new RegExp(`\\b(on |last )?${name}\\b`).test(t));
    if (named >= 0 && /\b(sent|shared|gave|forwarded|on|last)\b/.test(t)) {
      const weekday = new Date(start(today) + 12 * 60 * 60_000).getUTCDay();
      const back = ((weekday - named + 7) % 7) || 7;
      day = { from: start(today) - back * DAY_MS, to: start(today) - (back - 1) * DAY_MS };
    }
  }
  return { kinds, site, ...(day ? { day } : {}) };
}

/** Whether an item is the kind he asked for (a YouTube or Instagram link counts as a video). */
function kindMatches(item: LibraryItem, kinds: string[]): boolean {
  if (kinds.length === 0) return true;
  const site = siteOf(item.url);
  return kinds.some((kind) => {
    if (kind === "video") return item.kind === "video" || item.kind === "animation" || (item.kind === "link" && (site === "youtube" || site === "tiktok" || /instagram\.com\/(reel|p|tv)\//i.test(item.url ?? "")));
    if (kind === "voice") return item.kind === "voice" || item.kind === "audio";
    if (kind === "link") return item.kind === "link";
    return item.kind === kind;
  });
}

/** How well an item fits his words: shared words, the site, the kind, the day, then how recent it is. */
export function scoreItem(item: LibraryItem, query: string, now: Date): number {
  const wanted = wantedOf(query, now);
  const text = [item.title, item.description, item.note, item.url, siteOf(item.url)].filter(Boolean).join(" ");
  const have = stems(text);
  const words = [...stems(query)];
  let score = words.filter((word) => have.has(word)).length * 1.5;
  const site = siteOf(item.url);
  // The site is the link's own site; a file only names it in its words ("a screenshot of an Instagram post").
  if (wanted.site) score += site ? (site === wanted.site ? 3 : -2) : new RegExp(wanted.site, "i").test(text) ? 1.5 : -1;
  if (wanted.kinds.length) score += kindMatches(item, wanted.kinds) ? 2 : -3;
  const at = new Date(item.created_at).getTime();
  if (wanted.day) score += at >= wanted.day.from && at < wanted.day.to ? 3 : -3;
  const ageDays = Math.max(0, (now.getTime() - at) / DAY_MS);
  score += 0.5 * (1 - Math.min(ageDays, 30) / 30);
  return Math.round(score * 100) / 100;
}

/** Below this an item is not what he meant. */
export const MATCH = 2;

/**
 * The item he means, or the two or three that fit equally well (he is asked,
 * with their titles), or nothing.
 */
export function pickItem(items: LibraryItem[], query: string, now: Date): { found?: LibraryItem; choices?: LibraryItem[] } {
  const ranked = items
    .map((item) => ({ item, score: scoreItem(item, query, now) }))
    .filter((entry) => entry.score >= MATCH)
    .sort((a, b) => b.score - a.score || b.item.created_at.localeCompare(a.item.created_at));
  if (ranked.length === 0) return {};
  const [top, second] = ranked;
  // Two that fit just as well: he is asked which, never given the wrong one.
  if (second && second.score >= top.score - 0.5) return { choices: ranked.filter((entry) => entry.score >= top.score - 0.5).slice(0, 3).map((entry) => entry.item) };
  return { found: top.item };
}

/** An item in a few words, for a list or a button: "▶️ Instagram reel · Thu 20 Nov". */
export function itemLabel(item: LibraryItem, now = new Date()): string {
  const icon = item.album ? "📰" : item.kind === "link" ? (kindMatches(item, ["video"]) ? "▶️" : "🔗") : item.kind === "post" ? "📰" : item.kind === "photo" ? "🖼" : item.kind === "voice" || item.kind === "audio" ? "🎙" : item.kind === "video" || item.kind === "animation" || item.kind === "video_note" ? "🎞" : "📎";
  const site = siteOf(item.url);
  const name = item.album
    ? `${item.album} ${item.kind === "photo" ? "photos" : "files"} (one forwarded post)`
    : (
        (item.kind === "document" ? item.note?.trim() || fileNameOf(item) : undefined) ||
        item.title?.trim() ||
        item.note?.trim() ||
        item.description?.split("\n").pop()?.replace(/^Shows:\s*/, "").trim() ||
        (site ? `${site} ${item.kind}` : `Saved ${item.kind}`)
      ).replace(/\s+/g, " ");
  const at = new Date(item.created_at);
  const when = localDate(at) === localDate(now) ? "today" : new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
  return `${icon} ${name.length > 60 ? `${name.slice(0, 59)}…` : name} · ${when}`;
}

/** What a link is, when its page cannot be read: "Instagram reel", "YouTube video". */
export function describeUrl(url: string): string {
  const site = siteOf(url);
  if (site === "instagram") return /\/reel\//i.test(url) ? "Instagram reel" : /\/p\//i.test(url) ? "Instagram post" : "Instagram page";
  if (site === "youtube") return /shorts\//i.test(url) ? "YouTube short" : "YouTube video";
  if (site === "tiktok") return "TikTok video";
  if (site === "telegram") return "Telegram post";
  return site ? `Page on ${site}` : "Link";
}

/**
 * One item for the brain: its reference, what it is, when, what he said when
 * he sent it, and its task. `library:3 ▶️ Sevara on Instagram · today 18:10 ·
 * he said: "i have to shoot this type of videos" · task #48 Shoot videos like this reel`
 */
/** A document's file name: the first line of what Tony kept about it ("IELTS_Plan.pdf"). */
function fileNameOf(item: Pick<LibraryItem, "kind" | "description">): string | undefined {
  const first = item.kind === "document" ? item.description?.split("\n")[0]?.trim() : undefined;
  return first && /\.\w{2,5}$/.test(first) && first.length <= 120 ? first : undefined;
}

export function libraryLine(item: LibraryItem, now: Date, taskTitle?: string): string {
  const at = new Date(item.created_at);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  const label = itemLabel(item, now);
  // A document: what he wrote with it, and what it is about (its text is for library read, not this list).
  if (item.kind === "document") {
    const summary = /^Summary:\s*(.+)$/m.exec(item.description ?? "")?.[1]?.trim();
    const words = item.note?.trim() || item.title?.trim();
    return [
      `${item.source}:${item.id} ${label} ${time}`,
      words ? `he said: "${words.replace(/\s+/g, " ").slice(0, 140)}"` : undefined,
      summary ? `about: ${summary.slice(0, 200)}` : undefined,
      item.task_id ? `task #${item.task_id}${taskTitle ? ` ${taskTitle}` : ""}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const said = item.note?.trim() || (item.description && item.description !== describeUrl(item.url ?? "") && item.description !== item.title ? item.description.trim() : "");
  const kind = item.url ? describeUrl(item.url) : item.kind;
  return [
    `${item.source}:${item.id} ${label} ${time}`,
    item.url && item.title !== kind ? kind : undefined,
    said ? `he said: "${said.replace(/\s+/g, " ").slice(0, 140)}"` : undefined,
    item.task_id ? `task #${item.task_id}${taskTitle ? ` ${taskTitle}` : ""}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
