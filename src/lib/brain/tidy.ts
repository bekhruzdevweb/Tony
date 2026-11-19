/**
 * Small repairs to the model's wording before it reaches the lock screen.
 *
 * The model sometimes returns its reply twice in one string, glued together
 * with no space ("...at 21:32.Done, sir. ..."), either word for word or as
 * two phrasings of the same confirmation. The glue point is the giveaway, so
 * only what follows the last one is kept, and any sentence that repeats an
 * earlier one is dropped.
 */
export function tidyReply(text: string): string {
  const glued = text.trim().split(/(?<=[a-z0-9"”’)][.!?])(?=[A-Z“"])/);
  const last = glued[glued.length - 1]
    // Telegram shows plain text, so markdown emphasis is only noise.
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  const seen = new Set<string>();
  const sentences = last.split(/(?<=[.!?])\s+/).filter((sentence) => {
    const key = sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Rebuilding on spaces would flatten a list, so only do it when something was removed.
  return sentences.length === last.split(/(?<=[.!?])\s+/).length ? last : sentences.join(" ");
}
