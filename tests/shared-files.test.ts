/**
 * 22 Nov 01:49–01:59: what he shares comes back together and is read.
 * A task's photo and video go as one album under the task's name (never the
 * long description Tony read from the photo); a PDF or text file is read, and
 * what was read from it never counts as his words; after midnight the day just
 * begun is named the way he named it.
 */
import { describe, expect, it } from "vitest";
import { ownWords } from "../src/lib/brain/reliability";
import { mediaCaption, sendTogether, type Media } from "../src/lib/media";
import { dayWordIn, formatWhen } from "../src/lib/time";
import { readDocument, readableDocument } from "../src/lib/vision";

const file = (id: number, kind: Media["kind"], extra: Partial<Media> = {}): Media => ({
  id,
  kind,
  file_id: `F${id}`,
  file_unique_id: null,
  mime: null,
  caption: null,
  description: null,
  note: null,
  task_id: 61,
  storage_path: null,
  signed_url: null,
  signed_until: null,
  created_at: "2026-11-21T20:49:17Z",
  ...extra,
});

/** A bot whose every call is recorded. */
const recorder = () => {
  const calls: [string, unknown[]][] = [];
  const api = new Proxy({}, { get: (_target, name) => async (...args: unknown[]) => (calls.push([String(name), args.slice(0, 3)]), { message_id: calls.length }) });
  return { bot: { api } as never, calls };
};

describe("files sent back together", () => {
  const photo = file(86, "photo", { description: "22:36\nmosseri\n\nShows: A screenshot of an Instagram story posted by the account \"mosseri\" 19 hours earlier." });
  const video = file(87, "video", { caption: "this is how i should be uploading stories daily" });

  it("a task's photo and video: one album, under the task's name and his own words", async () => {
    const { bot, calls } = recorder();
    expect(await sendTogether(bot, 42, [photo, video], "Post stories in this format")).toEqual([86, 87]);
    expect(calls).toEqual([
      [
        "sendMediaGroup",
        [
          42,
          [
            { type: "photo", media: "F86", caption: "<b>Post stories in this format</b>\nthis is how i should be uploading stories daily", parse_mode: "HTML" },
            { type: "video", media: "F87" },
          ],
        ],
      ],
    ]);
  });

  it("one photo: its task's name as the caption, never the description Tony read from it", async () => {
    const { bot, calls } = recorder();
    await sendTogether(bot, 42, [photo], "Post stories in this format");
    expect(calls[0][0]).toBe("sendPhoto");
    expect((calls[0][1][2] as { caption: string }).caption).toBe("<b>Post stories in this format</b>");
    expect(mediaCaption(photo)).toBe("");
    expect(mediaCaption(video)).toBe("this is how i should be uploading stories daily");
  });

  it("a PDF goes after the album, on its own", async () => {
    const { bot, calls } = recorder();
    await sendTogether(bot, 42, [photo, file(88, "document"), video]);
    expect(calls.map(([name]) => name)).toEqual(["sendMediaGroup", "sendDocument"]);
  });
});

describe("documents he sends are read", () => {
  it("PDFs and plain text files, by type or by name; anything else is not", () => {
    expect(readableDocument("application/pdf")).toBe("pdf");
    expect(readableDocument("application/octet-stream", "IELTS_Plan.PDF")).toBe("pdf");
    expect(readableDocument("text/plain")).toBe("text");
    expect(readableDocument("application/octet-stream", "notes.md")).toBe("text");
    expect(readableDocument("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "plan.docx")).toBeUndefined();
  });

  it("a text file is read as it is", async () => {
    const bytes = new TextEncoder().encode("Week 1: Reading\nWeek 2: Listening\n").buffer as ArrayBuffer;
    expect(await readDocument(bytes, "text/plain", "plan.txt")).toBe("Week 1: Reading\nWeek 2: Listening");
  });

  it("what was read from a file is material: never his words, so a time inside it is not his", () => {
    const asked = 'can u see my ielts plan?\n\n[He attached a document "IELTS_Question_Type_Mastery_Plan.pdf"]\n«««\nText in the document "IELTS_Question_Type_Mastery_Plan.pdf":\nSummary: A four-week plan.\nText:\nWeek 1 at 9:00\n»»»';
    expect(ownWords(asked)).toBe("can u see my ielts plan?");
    // The photo's text too, all of it (01:49: lines after the first counted as his words).
    expect(ownWords("tmr remind me at 1:00 p.m to post stories at this format\n\n[He sent you a photo]\n«««\nText in the image: 22:36\n43\nmosseri\nAsk me anything\n»»»")).toBe("tmr remind me at 1:00 p.m to post stories at this format");
  });
});

describe("after midnight, the day just begun is named his way", () => {
  const now = new Date("2026-11-21T20:50:00Z"); // Sun 22 Nov, 01:50 in Tashkent
  const one = new Date("2026-11-22T08:00:00Z"); // Sun 22 Nov, 13:00
  it("'tmr' → tomorrow, 'today' → today, no word → the weekday and date alone", () => {
    expect(formatWhen(one, now, undefined, "tmr remind me at 1 p.m.")).toBe("tomorrow, Sun 22 Nov, 13:00");
    expect(formatWhen(one, now, undefined, "sorry i meant today")).toBe("today, Sun 22 Nov, 13:00");
    expect(formatWhen(one, now, undefined, "can u add this one to stories task")).toBe("Sun 22 Nov, 13:00");
    // Without his words (briefs, reminders), as before.
    expect(formatWhen(one, now)).toBe("tomorrow, Sun 22 Nov, 13:00");
    // In the daytime nothing changes.
    expect(formatWhen(one, new Date("2026-11-22T05:00:00Z"), undefined, "sorry i meant today")).toBe("today, Sun 22 Nov, 13:00");
  });
  it("his day words in three languages", () => {
    expect(dayWordIn("ertaga soat 1da")).toBe("tomorrow");
    expect(dayWordIn("bugun")).toBe("today");
    expect(dayWordIn("завтра в 13")).toBe("tomorrow");
    expect(dayWordIn("сегодня")).toBe("today");
    expect(dayWordIn("add it")).toBeUndefined();
  });
});
