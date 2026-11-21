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
};

const DAY_MS = 24 * 60 * 60_000;

/** Words that say nothing about which item he means. */
const STOP = new Set(
  "send sent give show find that this those these which what where when there here with from about have please could would just again tony thing things item items link links video videos photo photos picture pictures image images post posts file files voice note notes message yesterday today tonight morning evening week last earlier before sent ago days attach attached task tasks open watch".split(" "),
);

const stems = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP.has(word)).map((word) => word.slice(0, 5)));

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
  const icon = item.kind === "link" ? (kindMatches(item, ["video"]) ? "▶️" : "🔗") : item.kind === "post" ? "📰" : item.kind === "photo" ? "🖼" : item.kind === "voice" || item.kind === "audio" ? "🎙" : item.kind === "video" || item.kind === "animation" || item.kind === "video_note" ? "🎞" : "📎";
  const site = siteOf(item.url);
  const name = (item.title?.trim() || item.note?.trim() || item.description?.split("\n").pop()?.replace(/^Shows:\s*/, "").trim() || (site ? `${site} ${item.kind}` : `Saved ${item.kind}`)).replace(/\s+/g, " ");
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
export function libraryLine(item: LibraryItem, now: Date, taskTitle?: string): string {
  const at = new Date(item.created_at);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  const label = itemLabel(item, now);
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
