/**
 * Links he sends: the pure rules (no database), tested in tests/links.test.ts.
 *
 * - A link sent with a task, or just before it, goes into that task's notes,
 *   and the confirmation says so ("🔗 link saved").
 * - Tony never asks whether to attach a link he just sent.
 * - "Send me the video" is answered with the link, at once.
 */

/** What he typed himself, without the block Tony adds about what he forwarded or attached. */
export const ownWords = (value: string) => value.replace(/«««[\s\S]*?»»»/g, " ").replace(/\[He [^\]]*\]/g, " ").replace(/[ \t]+/g, " ").trim();

/** A photo, video or file came with his words (forwarded, attached or sent). */
export const carriesMedia = (value: string) => /\[He (forwarded|attached|sent you)\b/.test(value);

/** "Send me the video", "can u send it even now the link o podcast", "what was the link?" */
export function asksForLink(text: string): boolean {
  return (
    // Asked of Tony ("send me…", "send it…", "resend the link"), not a task ("send the video to Aziz").
    /\b(send|give|show|share|paste|forward|drop)\s+(me|it|them|us)\b[^.?!]{0,40}\b(links?|urls?|videos?|podcasts?|reels?|course|masterclass|articles?)\b/i.test(text) ||
    /\bresend\b[^.?!]{0,25}\b(links?|urls?|videos?|podcasts?|reels?)\b/i.test(text) ||
    /\b(what|where)('?s| is| was)\b[^.?!]{0,25}\b(link|url)\b/i.test(text)
  );
}

/** A reply that asks whether to attach a link or file instead of doing it ("Shall I add the link to the notes…?"). */
export function asksToAttachLink(reply: string): boolean {
  const plain = reply.replace(/[*_`]/g, "");
  return (
    /\b(add|attach|put|keep|save|include|store)\b[^.?!]{0,60}\b(link|url|screenshot)s?\b[^.?!]*\?/i.test(plain) ||
    /\bwhich\b[^.?!]{0,30}\b(attach|link)\b[^.?!]*\?/i.test(plain) ||
    /^\s*attach\b[^.?!]*\?/im.test(plain)
  );
}

/** His words point at something he just sent ("watch this video", "remind me about it", "save that link"). */
export function refersToLink(text: string): boolean {
  return /\b(watch|read|listen|video|link|reel|podcast|post|course|masterclass|article|episode)\b|\b(this|that) one\b/i.test(text);
}

/** A title that says nothing about the page ("Watch the video", "Read this"): it gets the page's own title. */
export function isGenericTitle(title: string): boolean {
  return /^(watch|read|listen to|check|check out|open|see|view|look at)(\s+(this|the|that|a|my|his))?(\s+(youtube\s+)?(video|link|reel|podcast|post|article|page|course|masterclass|clip|one|episode))?(\s+(later|again|tomorrow|today|on \w+))?$/i.test(title.trim());
}

/** "Watch" for videos and reels, "Read" for everything else. */
export function verbFor(url: string): "Watch" | "Read" {
  return /youtu\.?be|vimeo\.com|instagram\.com\/(reel|tv|p)\/|tiktok\.com|twitch\.tv|\/video/i.test(url) ? "Watch" : "Read";
}

/** A task's title for a link: his own if it says something, else "Watch: <page title>". */
export function titleForLink(title: string, url: string, pageTitle?: string): string {
  // A stand-in like "YouTube video" says no more than his own words.
  if (!isGenericTitle(title) || !pageTitle?.trim() || /^(youtube video|instagram (reel|post)|telegram post)$/i.test(pageTitle.trim())) return title;
  const clean = pageTitle.replace(/\s*[-|·]\s*(YouTube|Instagram|TikTok)\s*$/i, "").trim();
  return `${verbFor(url)}: ${clean}`.slice(0, 120);
}

export type LinkCandidate = { url: string; title: string; context: string; at: number };

const STOP = new Set(
  (
    "send give show share paste forward drop resend please just check again even now once more what where was is the that this those these link links url urls video videos podcast podcasts reel reels about which told everything want need tony sir " +
    // Common words say nothing about which link he means ("you", "can", "from", "saved", "here").
    "you your yours can cant cannot could would should will from here there have has had been being with without into onto over under also only then than them they their when while whenever how why who whom its it's not but and for are were did does doing done get got see saw say said tell told know make made like just very much more most some any all one two out off our ours his her him she mine me my i'm i've saved save attached attach task tasks label filed inside open opened cover covers covered anything something nothing thing things"
  ).split(" "),
);
const stems = (text: string) => new Set((text.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((word) => !STOP.has(word)).map((word) => word.slice(0, 5)));

/**
 * The links he most likely means, best first: by the words he used (the
 * title and what was said around the link), then by the kind he named
 * (video, reel, podcast), then the newest.
 */
export function rankLinks(request: string, candidates: LinkCandidate[], recent: string[] = []): (LinkCandidate & { points: number; words: number })[] {
  const wanted = stems(request);
  const lower = request.toLowerCase();
  // What Tony just said (a reminder, a reply), newest first: "send me the link" means that task's link.
  const recentLower = recent.map((text) => text.toLowerCase());
  // "This video", "that link": the one he sent last, if it was in the last half hour.
  const newest = Math.max(0, ...candidates.map((candidate) => candidate.at));
  const pointsAtLast = /\b(this|that|it)\b/.test(lower);
  const score = (candidate: LinkCandidate) => {
    const have = stems(`${candidate.title} ${candidate.context}`);
    const words = [...wanted].filter((stem) => have.has(stem)).length;
    let points = words * 3;
    const title = candidate.title.trim().toLowerCase();
    const said = title.length >= 4 ? recentLower.findIndex((text) => text.includes(title)) : -1;
    if (said >= 0) points += Math.max(1, 4 - said);
    if (pointsAtLast && candidate.at === newest && newest > 0) points += 3;
    if (/\binstagram\b|\binsta\b/.test(lower) && /instagram\.com/i.test(candidate.url)) points += 2;
    if (/\byoutube\b/.test(lower) && /youtu\.?be/i.test(candidate.url)) points += 2;
    if (/\b(video|watch)\b/.test(lower) && verbFor(candidate.url) === "Watch") points += 1;
    if (/\breel\b/.test(lower) && /instagram\.com\/reel/i.test(candidate.url)) points += 2;
    if (/\bpodcast\b/.test(lower) && /podcast/i.test(`${candidate.title} ${candidate.context}`)) points += 2;
    return { points, words };
  };
  const unique = new Map<string, LinkCandidate & { points: number; words: number }>();
  for (const candidate of candidates) {
    const { points, words } = score(candidate);
    const known = unique.get(candidate.url);
    // The same link seen twice keeps its best description and its newest time.
    if (!known || points > known.points || (points === known.points && candidate.at > known.at)) unique.set(candidate.url, { ...candidate, points, words, at: Math.max(candidate.at, known?.at ?? 0) });
  }
  return [...unique.values()].sort((a, b) => b.points - a.points || b.at - a.at);
}
