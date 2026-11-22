/**
 * Tags (Phase H): his own words for a theme, so "show my content tasks"
 * works across projects. Stored lower case, without the "#". Pure, so the
 * app's screens use the same rules as the server.
 *
 * Where they come from: the tags he names ("#content", "tag it ielts"), and
 * a titled series ("IELTS: Reading + Listening" is #ielts, "Workout: Legs A"
 * is #workout), so a plan's sessions are found together.
 */
export const MAX_TAGS = 6;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,23}$/u;

/** One tag as stored: lower case, no "#", letters and digits (and _ -), or undefined if it is not one. */
export function normalTag(raw: string): string | undefined {
  const tag = raw.trim().replace(/^#+/, "").toLowerCase();
  return TAG.test(tag) && !/^\d+$/.test(tag) ? tag : undefined;
}

/** Tags without repeats, at most six, in the order given. */
export function normalTags(list: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const item of list) {
    const tag = typeof item === "string" ? normalTag(item) : undefined;
    if (tag && !seen.has(tag)) seen.add(tag);
  }
  return [...seen].slice(0, MAX_TAGS);
}

/** "IELTS: Reading + Listening" → "ielts"; a title without a short name before a colon has none. */
export function prefixTag(title: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9]{1,14}):\s/.exec(title.trim());
  return match ? normalTag(match[1]) : undefined;
}

/** The hashtags in his words: "#content #ielts" → content, ielts. A "#5" is not a tag. */
export function hashtags(text: string): string[] {
  return normalTags([...text.matchAll(/(?:^|[\s(,])#([\p{L}\p{N}_-]{2,24})/gu)].map((match) => match[1]));
}

/** A new task's tags: the ones asked for, his hashtags, and its series name. */
export function tagsFor(title: string, given: readonly unknown[] = [], said = ""): string[] {
  return normalTags([...given, ...hashtags(said), prefixTag(title)].filter((tag): tag is string => typeof tag === "string"));
}

/** "#ielts #content", for a line about a task; empty when it has none. */
export const tagText = (tags: readonly string[] | null | undefined) => (tags ?? []).map((tag) => `#${tag}`).join(" ");
