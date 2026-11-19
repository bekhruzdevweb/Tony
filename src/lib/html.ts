/**
 * Telegram's HTML formatting. Everything the user typed (task titles,
 * project names, memory notes) goes through esc() before it is put inside
 * markup, so a title like "a < b & c" can never break a message.
 */
export const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const b = (text: string) => `<b>${esc(text)}</b>`;
export const i = (text: string) => `<i>${esc(text)}</i>`;
export const code = (text: string) => `<code>${esc(text)}</code>`;

/** A section that Telegram shows collapsed, with a tap to expand. */
export const expandable = (html: string) => `<blockquote expandable>${html}</blockquote>`;

/** The same message without markup: for the app's chat, logs, and a fallback if Telegram rejects the HTML. */
export function plain(html: string): string {
  return html
    .replace(/<\/?(?:b|i|u|s|code|pre|blockquote)(?:\s[^>]*)?>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const TIME = /\b(?:(?:today|tomorrow|yesterday|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*(?:\s+\d{1,2}\s+[A-Z][a-z]{2,8})?)\s+(?:at\s+)?)?\d{1,2}:\d{2}\b/gi;

/**
 * A plain sentence (the model's confirmation) as HTML, with the task names
 * and the times in bold: "Noted, sir. <b>Workout</b> <b>today at 18:00</b>".
 */
export function emphasise(text: string, titles: string[] = []): string {
  // Mark what to bold on the raw text, then escape, so offsets and escaping cannot disagree.
  const OPEN = "\u0001";
  const CLOSE = "\u0002";
  let marked = text.replace(/[\u0001\u0002]/g, "");
  const wanted = [...new Set(titles.map((title) => title.trim()).filter((title) => title.length >= 2))].sort((x, y) => y.length - x.length);
  for (const title of wanted) {
    const pattern = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    // Only outside what is already marked.
    marked = marked
      .split(new RegExp(`(${OPEN}[^${CLOSE}]*${CLOSE})`))
      .map((part, index) => (index % 2 === 1 ? part : part.replace(pattern, (found) => `${OPEN}${found}${CLOSE}`)))
      .join("");
  }
  marked = marked
    .split(new RegExp(`(${OPEN}[^${CLOSE}]*${CLOSE})`))
    .map((part, index) => (index % 2 === 1 ? part : part.replace(TIME, (found) => `${OPEN}${found}${CLOSE}`)))
    .join("");
  return esc(marked).replaceAll(OPEN, "<b>").replaceAll(CLOSE, "</b>");
}
