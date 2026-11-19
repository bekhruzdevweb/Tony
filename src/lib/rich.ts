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

  // Folding quotations first: they may span blank lines.
  const pieces = html.split(/(<blockquote(?: expandable)?>[^]*?<\/blockquote>)/);
  for (const piece of pieces) {
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

/** Sends a message in rich form, or as plain HTML if Telegram will not take it. */
export async function sendRich(bot: Bot, chatId: number, html: string, options: { keyboard?: InlineKeyboard; silent?: boolean } = {}): Promise<number> {
  try {
    const sent = await bot.api.sendRichMessage(chatId, richFromHtml(html), { reply_markup: options.keyboard, disable_notification: options.silent });
    return sent.message_id;
  } catch (error) {
    console.error("A rich message was refused; sending it as HTML:", error);
    return sendHtml(bot, chatId, html, options);
  }
}

/** Edits a message sent by sendRich, in rich form if it can, otherwise as HTML. */
export async function editRich(bot: Bot, chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<boolean> {
  try {
    await bot.api.editMessageText(chatId, messageId, richFromHtml(html), { reply_markup: keyboard });
    return true;
  } catch (error) {
    if (/message is not modified/i.test(String((error as { description?: string })?.description ?? error))) return true;
    return editHtml(bot, chatId, messageId, html, keyboard);
  }
}
