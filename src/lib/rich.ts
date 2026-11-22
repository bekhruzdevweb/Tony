import "server-only";
import type { Bot, InlineKeyboard } from "grammy";
import { editHtml, sendHtml } from "./chat-log";

/**
 * Telegram rich messages (Bot API 10.1+): headings, lists, quotations.
 *
 * Tony's messages are written once, in the small HTML Telegram has always
 * taken (<b>, <i>, <s>, <u>, <code>, <blockquote>), and turned into rich
 * blocks here. If Telegram refuses the rich form, the same HTML is sent as
 * an ordinary message, so nothing is lost.
 *
 * The shapes the HTML is read in:
 *   - paragraphs are separated by a blank line;
 *   - a line that is wholly bold is a heading; the lines under it are a list;
 *   - an indented line continues the list item above it (a plan's "why");
 *   - <blockquote expandable> becomes a folding quotation.
 */
export type RichMessage = Parameters<Bot["api"]["sendRichMessage"]>[1];
type RichBlock = NonNullable<RichMessage["blocks"]>[number];
type ListItem = Extract<RichBlock, { type: "list" }>["items"][number];
type ItemBlock = ListItem["blocks"][number];
type RichText = Extract<RichBlock, { type: "paragraph" }>["text"];

const STYLE: Record<string, "bold" | "italic" | "strikethrough" | "underline" | "code"> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  s: "strikethrough",
  u: "underline",
  code: "code",
};

const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** Inline HTML (<b>, <i>, <s>, <u>, <code>) as rich text. Unknown tags are dropped, their words kept. */
export function richText(html: string): RichText {
  const root: RichText[] = [];
  const stack: { tag: string; parts: RichText[] }[] = [{ tag: "", parts: root }];
  const pattern = /<(\/?)([a-z]+)[^>]*>/gi;
  let at = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match.index > at) stack[stack.length - 1].parts.push(unescape(html.slice(at, match.index)));
    at = match.index + match[0].length;
    const tag = match[2].toLowerCase();
    if (!STYLE[tag]) continue;
    if (!match[1]) {
      stack.push({ tag, parts: [] });
    } else if (stack.length > 1 && stack[stack.length - 1].tag === tag) {
      const done = stack.pop()!;
      const inner: RichText = done.parts.length === 1 ? done.parts[0] : done.parts;
      stack[stack.length - 1].parts.push({ type: STYLE[tag], text: inner } as RichText);
    }
  }
  if (at < html.length) stack[stack.length - 1].parts.push(unescape(html.slice(at)));
  // Anything left open is closed at the end.
  while (stack.length > 1) {
    const done = stack.pop()!;
    stack[stack.length - 1].parts.push({ type: STYLE[done.tag], text: done.parts.length === 1 ? done.parts[0] : done.parts } as RichText);
  }
  return root.length === 1 ? root[0] : root;
}

/** A line that is wholly bold, perhaps after an emoji ("⚠️ <b>Overdue</b>"): its heading text, or undefined. */
function headingOf(line: string): string | undefined {
  const match = /^\s*([^<\s]{1,4}\s)?<b>([^]*)<\/b>\s*$/.exec(line);
  if (!match || /<\/b>|<b>/.test(match[2])) return undefined;
  return `${match[1] ?? ""}${match[2]}`;
}
const plainLine = (line: string) => line.replace(/^\s*[•·-]\s+/, "").trim();

/** One of Tony's HTML messages as rich blocks. */
export function richFromHtml(html: string): RichMessage {
  const blocks: RichBlock[] = [];
  let headings = 0;

  // Folding quotations and tables first: they may span lines.
  const pieces = html.split(/(<blockquote(?: expandable)?>[^]*?<\/blockquote>|<table>[^]*?<\/table>)/);
  for (const piece of pieces) {
    if (piece.startsWith("<table>")) {
      const cells = (piece.match(/<tr>[^]*?<\/tr>/g) ?? []).map((row) =>
        (row.match(/<t[hd]>[^]*?<\/t[hd]>/g) ?? []).map((cell) => ({
          text: richText(cell.replace(/^<t[hd]>|<\/t[hd]>$/g, "")),
          ...(cell.startsWith("<th>") ? { is_header: true as const } : {}),
          align: "left" as const,
          valign: "middle" as const,
        })),
      );
      blocks.push({ type: "table", cells, is_bordered: true, is_compact: true } as RichBlock);
      continue;
    }
    const quote = /^<blockquote( expandable)?>([^]*)<\/blockquote>$/.exec(piece);
    if (quote) {
      blocks.push(quote[1] ? { type: "expandable_blockquote", text: richText(quote[2]) } : { type: "blockquote", blocks: [{ type: "paragraph", text: richText(quote[2]) }] });
      continue;
    }
    for (const paragraph of piece.split(/\n{2,}/)) {
      const lines = paragraph.split("\n").filter((line) => line.trim() !== "");
      if (lines.length === 0) continue;
      // Lines that are not headings or indented continuations: two or more of them make a list.
      const entries = lines.filter((line) => headingOf(line) === undefined && !/^\s{2,}\S/.test(line)).length;
      const hasHeading = lines.some((line) => headingOf(line) !== undefined);
      let items: ListItem[] | undefined = !hasHeading && entries >= 2 ? [] : undefined;
      if (items) blocks.push({ type: "list", items });
      for (const line of lines) {
        const heading = headingOf(line);
        if (heading !== undefined) {
          // The first heading is the title; later ones are section headings.
          blocks.push({ type: "heading", size: headings++ === 0 ? 2 : 4, text: richText(heading.trim()) });
          items = [];
          blocks.push({ type: "list", items });
        } else if (items && /^\s{2,}\S/.test(line) && items.length > 0) {
          // An indented line belongs to the item above it.
          (items[items.length - 1].blocks as ItemBlock[]).push({ type: "paragraph", text: richText(line.trim()) });
        } else if (items) {
          items.push({ blocks: [{ type: "paragraph", text: richText(plainLine(line)) }] });
        } else {
          blocks.push({ type: "paragraph", text: richText(line.trim()) });
        }
      }
    }
  }
  // A heading with nothing under it leaves an empty list; drop those.
  return { blocks: blocks.filter((block) => !(block.type === "list" && block.items.length === 0)), skip_entity_detection: true };
}

/** Plain Telegram HTML has no tables: each row becomes a line ("13:00 · Presentation · 60 min"). */
export function tablesAsLines(html: string): string {
  return html.replace(/<table>([^]*?)<\/table>/g, (_, body: string) =>
    (body.match(/<tr>[^]*?<\/tr>/g) ?? [])
      .map((row) => (row.match(/<t[hd]>([^]*?)<\/t[hd]>/g) ?? []).map((cell) => cell.replace(/<\/?t[hd]>/g, "")).filter(Boolean).join(" · "))
      .map((line, index) => (index === 0 ? `<b>${line}</b>` : line))
      .join("\n"),
  );
}

/** Sends a message in rich form, or as plain HTML if Telegram will not take it. */
export async function sendRich(bot: Bot, chatId: number, html: string, options: { keyboard?: InlineKeyboard; silent?: boolean } = {}): Promise<number> {
  try {
    const sent = await bot.api.sendRichMessage(chatId, richFromHtml(html), { reply_markup: options.keyboard, disable_notification: options.silent });
    return sent.message_id;
  } catch (error) {
    console.error("A rich message was refused; sending it as HTML:", error);
    return sendHtml(bot, chatId, tablesAsLines(html), options);
  }
}

/** Edits a message sent by sendRich, in rich form if it can, otherwise as HTML. */
export async function editRich(bot: Bot, chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<boolean> {
  try {
    await bot.api.editMessageText(chatId, messageId, richFromHtml(html), { reply_markup: keyboard });
    return true;
  } catch (error) {
    if (/message is not modified/i.test(String((error as { description?: string })?.description ?? error))) return true;
    return editHtml(bot, chatId, messageId, tablesAsLines(html), keyboard);
  }
}

// ---------------------------------------------------------------------------
// The brain's replies: Telegram rich markdown (lists, task lists, tables,
// headings), sent as a rich message, with an HTML copy as the fallback.

const escHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const TASK_ITEM = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Markdown emphasis inside one line, as Telegram HTML. */
function inlineHtml(text: string): string {
  // Code spans first, so nothing inside them is touched.
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escHtml(part.slice(1, -1))}</code>`;
      return escHtml(part)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, x?: string, y?: string) => `<b>${x ?? y}</b>`)
        .replace(/~~(.+?)~~/g, "<s>$1</s>")
        .replace(/\|\|(.+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
        .replace(/==(.+?)==/g, "$1")
        .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "<i>$1</i>")
        .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "<i>$1</i>");
    })
    .join("");
}

/** A rich-markdown reply as plain Telegram HTML: lists become lines, tables become rows. */
export function markdownToHtml(markdown: string): string {
  // Buttons inside the text ("✓ Done" on a task line) exist only in the rich form.
  markdown = markdown.replace(/\s*<tg-button\b[^>]*>[^<]*<\/tg-button>/g, "");
  const out: string[] = [];
  let quote: string[] = [];
  let headerRow = true;
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  for (const line of markdown.split("\n")) {
    const inQuote = QUOTE.exec(line);
    if (inQuote) {
      quote.push(inlineHtml(inQuote[1]));
      continue;
    }
    flushQuote();
    if (TABLE_ROW.test(line)) {
      if (TABLE_RULE.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineHtml(cell.trim()));
      out.push(headerRow ? `<b>${cells.join(" · ")}</b>` : cells.join("  "));
      headerRow = false;
      continue;
    }
    headerRow = true;
    let match: RegExpExecArray | null;
    if ((match = HEADING.exec(line))) out.push(`<b>${inlineHtml(match[1])}</b>`);
    else if ((match = TASK_ITEM.exec(line))) out.push(`${match[1] === " " ? "☐" : "☑"} ${inlineHtml(match[2])}`);
    else if ((match = BULLET.exec(line))) out.push(`• ${inlineHtml(match[1])}`);
    else if ((match = NUMBERED.exec(line))) out.push(`${match[1]}. ${inlineHtml(match[2])}`);
    else out.push(inlineHtml(line));
  }
  flushQuote();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The words of a markdown line with its markup taken out. */
const bare = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`|=#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Whether a reply is more than prose: it has a list, a table or a heading. */
export function hasStructure(markdown: string): boolean {
  return markdown.split("\n").some((line) => TABLE_ROW.test(line) || TASK_ITEM.test(line) || BULLET.test(line) || NUMBERED.test(line) || HEADING.test(line));
}

/**
 * What is said aloud for a reply: its prose only, never the list or table
 * (those are in the chat). A reply that is only a list gets a short line saying so.
 */
export function spokenFromMarkdown(markdown: string): string {
  let items = 0;
  const prose: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim()) continue;
    if (TABLE_ROW.test(line)) {
      if (!TABLE_RULE.test(line)) items++;
      continue;
    }
    if (TASK_ITEM.test(line) || BULLET.test(line) || NUMBERED.test(line)) {
      items++;
      continue;
    }
    if (HEADING.test(line)) continue;
    prose.push(bare(line.replace(QUOTE, "$1")));
  }
  const said = prose.join(" ").trim();
  if (said) return said;
  return items > 0 ? "Here it is, sir. The details are in the chat." : bare(markdown);
}

/** Times (18:00) in bold, unless they already are or sit in code. */
export function boldTimes(markdown: string): string {
  return markdown
    .split(/(`[^`]+`)/)
    .map((part) => (/^`[^`]+`$/.test(part) ? part : part.replace(/(?<![*\w:])([01]?\d|2[0-3]):[0-5]\d(?![\w*:])/g, "**$&**")))
    .join("");
}

/** The reply's markdown as plain text, for places with no formatting (the app's chat). */
export function markdownToPlain(markdown: string): string {
  return markdownToHtml(markdown)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Sends one of the brain's replies: rich markdown as a rich message, or, if
 * Telegram refuses it, the same reply converted to HTML.
 */
export async function sendMarkdown(bot: Bot, chatId: number, markdown: string, options: { keyboard?: InlineKeyboard; silent?: boolean; fallback?: string } = {}): Promise<number> {
  try {
    const sent = await bot.api.sendRichMessage(chatId, { markdown }, { reply_markup: options.keyboard, disable_notification: options.silent });
    return sent.message_id;
  } catch (error) {
    // A reply with buttons in its text that Telegram would not take: the same reply without them.
    if (options.fallback !== undefined && options.fallback !== markdown) {
      console.error("A rich reply with buttons was refused; sending it without them:", error);
      return sendMarkdown(bot, chatId, options.fallback, { keyboard: options.keyboard, silent: options.silent });
    }
    console.error("A rich reply was refused; sending it as HTML:", error);
    return sendHtml(bot, chatId, markdownToHtml(markdown), options);
  }
}
