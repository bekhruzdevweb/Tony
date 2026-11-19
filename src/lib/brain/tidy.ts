/**
 * Removes what the model sometimes leaks around its answer:
 * - filler before the real text, seen as runs of dots with stray words
 *   ("...... ......... The........ The...... Noted, sir.");
 * - leftover markers from its internal format;
 * - internal task numbers ("#5"), which mean nothing to the user.
 */
export function stripJunk(text: string, taskIds: number[] = []): string {
  let out = text
    .replace(/…/g, "...")
    .replace(/<\|[^|>]{0,40}\|>/g, " ")
    .trim()
    .replace(/^(?:analysis|commentary|final)\b[:\s]*/i, "");
  // Filler: four or more dots are never punctuation, with or without a stray word in front.
  // ("Hmm... very well" has three and is left alone.)
  out = out.replace(/^(?:\s*(?:[A-Za-z]{1,12})?\.{4,})+\s*/, "");
  out = out.replace(/\s*(?:\b[A-Za-z]{1,12})?\.{4,}/g, " ");
  // "task #5", "(#5)", "#5 Read some books": drop the number, keep the words.
  // Only numbers that are really task numbers, so "Room #4" in a title survives.
  for (const id of taskIds) {
    out = out
      .replace(new RegExp(`\\s*\\(#${id}\\)`, "g"), "")
      .replace(new RegExp(`(^|[\\s"“(])#${id}\\b[:,]?\\s*`, "g"), "$1");
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,!?])/g, "$1").trim();
}

/**
 * Small repairs to the model's wording before it reaches the lock screen.
 *
 * The model sometimes returns its reply twice in one string, glued together
 * with no space ("...at 21:32.Done, sir. ..."), either word for word or as
 * two phrasings of the same confirmation. The glue point is the giveaway, so
 * only what follows the last one is kept, and any sentence that repeats an
 * earlier one is dropped.
 */
export function tidyReply(raw: string, taskIds: number[] = []): string {
  const text = stripJunk(raw, taskIds);
  const glued = text.trim().split(/(?<=[a-z0-9"”’)][.!?])(?=[A-Z“])/);
  // A real second copy is a whole reply; a few stray characters are not.
  const tail = glued[glued.length - 1];
  const last = (glued.length > 1 && tail.trim().length < 12 ? text.trim() : tail)
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
