/**
 * Times and days as he says them, in English, Uzbek and Russian (21 Nov audit):
 * the code that holds the model to his time must understand his time, or it
 * drops it and asks "what time?" after he said "soat 9da".
 */
import { describe, expect, it } from "vitest";
import { givenTimes } from "../src/lib/brain/reliability";
import { dayFromText } from "../src/lib/schedule";

const now = new Date("2026-11-21T14:30:00Z"); // Sat 21 Nov, 19:30 in Tashkent
const minutes = (text: string) => givenTimes(text, now).map((time) => ("minutes" in time ? time.minutes : [time.at.toISOString()]));
const day = (text: string) => dayFromText(text, now)?.toISOString().slice(0, 10);

describe("times in his three languages", () => {
  it("Uzbek", () => {
    expect(minutes("ertaga soat 9da")).toEqual([[540, 1260]]);
    expect(minutes("bugun kechqurun 8da")).toEqual([[1200]]);
    expect(minutes("ertalab 7 da")).toEqual([[420]]);
    expect(minutes("soat 9 yarimda")).toEqual([[570, 1290]]);
    expect(minutes("yarim soatdan keyin")).toEqual([["2026-11-21T15:00:00.000Z"]]);
    expect(minutes("2 soatdan keyin")).toEqual([["2026-11-21T16:30:00.000Z"]]);
    // "after 9" is not a time; "2 days" and "5 games" are not times.
    expect(minutes("9 dan keyin")).toEqual([]);
    expect(minutes("in 2 days I play 5 games")).toEqual([]);
  });
  it("Russian", () => {
    expect(minutes("завтра в 9 утра")).toEqual([[540]]);
    expect(minutes("в 7 вечера")).toEqual([[1140]]);
    expect(minutes("в 3 дня")).toEqual([[900]]);
    expect(minutes("в 2 ночи")).toEqual([[120]]);
    expect(minutes("в 10 ночи")).toEqual([[1320]]);
    expect(minutes("в полдень")).toEqual([[720]]);
    expect(minutes("через полчаса")).toEqual([["2026-11-21T15:00:00.000Z"]]);
    expect(minutes("через 2 часа")).toEqual([["2026-11-21T16:30:00.000Z"]]);
  });
  it("English he uses", () => {
    expect(minutes("at noon")).toEqual([[720]]);
    expect(minutes("at midnight")).toEqual([[0]]);
    expect(minutes("half past 8")).toEqual([[510, 1230]]);
    expect(minutes("quarter to 9")).toEqual([[525, 1245]]);
  });
});

describe("days in his three languages", () => {
  it("relative days", () => {
    expect(day("ertaga")).toBe("2026-11-22");
    expect(day("завтра")).toBe("2026-11-22");
    expect(day("indinga")).toBe("2026-11-23");
    expect(day("послезавтра")).toBe("2026-11-23");
    expect(day("bugun")).toBe("2026-11-21");
  });
  it("weekdays, weekends and dates", () => {
    expect(day("dushanba kuni")).toBe("2026-11-23");
    expect(day("payshanba")).toBe("2026-11-26");
    expect(day("yakshanba")).toBe("2026-11-22");
    expect(day("в пятницу")).toBe("2026-11-27");
    expect(day("this weekend")).toBe("2026-11-21");
    expect(day("on 25th")).toBe("2026-11-25");
    expect(day("25-noyabr")).toBe("2026-11-25");
    expect(day("25 ноября")).toBe("2026-11-25");
    expect(day("Nov 25")).toBe("2026-11-25");
    expect(day("some day")).toBeUndefined();
  });
});
