/**
 * Phases b–e, the pure rules: bursts, situation rules, the Free Time list,
 * the follow-up ladder, the notification budget, and the library's search.
 * From his real messages where there are some.
 */
import { describe, expect, it } from "vitest";
import {
  asksForRules,
  downtime,
  freeTimeText,
  groupBursts,
  isFreeTimeRequest,
  isRuleRequest,
  mergeable,
  missedToday,
  pickFreeItem,
  ruleHints,
  saysFree,
  skipTrigger,
  slippedDays,
  staleInbox,
  stillOpen,
  type OpenTask,
} from "../src/lib/smart-rules";
import { describeUrl, groupAlbums, isNotThatOne, itemLabel, labelHit, labelMatch, pickItem, rankItems, type LibraryItem } from "../src/lib/library-rules";

const at = (local: string) => new Date(`${local}:00+05:00`);
const iso = (local: string) => at(local).toISOString();

describe("b) Bursts: messages within a minute are one request", () => {
  it("23:25 the masterclass screenshot, then 'THIS REEL WHICH I SENT YOU', then a link: one request; a message two minutes later is another", () => {
    const rows = [
      { id: 1, received_at: iso("2026-11-20T23:25") },
      { id: 2, received_at: new Date(at("2026-11-20T23:25").getTime() + 20_000).toISOString() },
      { id: 3, received_at: new Date(at("2026-11-20T23:25").getTime() + 50_000).toISOString() },
      { id: 4, received_at: iso("2026-11-20T23:27") },
    ];
    expect(groupBursts(rows).map((group) => group.map((row) => row.id))).toEqual([[1, 2, 3], [4]]);
  });
});

describe("b) Situation rules", () => {
  const rule = { id: 1, situation: "when I'm not motivated to work out" };
  it("a motivation rule about workouts also fires after 3 days without one; his own number wins", () => {
    expect(skipTrigger(rule.situation)).toEqual({ kind: "workout", days: 3 });
    expect(skipTrigger("if I skip the gym for 2 days")).toEqual({ kind: "workout", days: 2 });
    expect(skipTrigger("when I feel sad")).toBeUndefined();
  });
  it("'I'm tired, don't want to work out' matches it; 'what's my workout tomorrow?' does not", () => {
    expect(ruleHints("I'm tired, don't want to work out", [rule]).map((r) => r.id)).toEqual([1]);
    expect(ruleHints("what's my workout tomorrow?", [rule])).toEqual([]);
    expect(ruleHints("I'm tired of grammar", [rule])).toEqual([]);
  });
  it("'when I'm not motivated…, send me this video' is a rule to keep; 'If you remember…, can you send it to me' is a request (15:41)", () => {
    expect(isRuleRequest("when I'm not motivated to work out, send me this video")).toBe(true);
    expect(isRuleRequest("if I skip the gym for 2 days, send me the clip")).toBe(true);
    expect(isRuleRequest("If you remember I sent you a one-post like add this feature to my website, can you send it to me with this image?")).toBe(false);
    expect(isRuleRequest("send me that video")).toBe(false);
  });
  it("'show my rules' and its variants, never 'rules for the club'", () => {
    for (const text of ["show my rules", "my rules", "rules", "what are my rules?", "list my rules"]) expect(asksForRules(text)).toBe(true);
    expect(asksForRules("write the rules for the speaking club")).toBe(false);
  });
});

describe("c) Free Time list and suggestions", () => {
  it("'in my free time', 'someday', 'when I'm free' go to the Free Time list", () => {
    expect(isFreeTimeRequest("save this masterclass to watch in my free time")).toBe(true);
    expect(isFreeTimeRequest("someday I want to learn the guitar")).toBe(true);
    expect(isFreeTimeRequest("when I'm free remind me to read this")).toBe(true);
    expect(isFreeTimeRequest("remind me to call the bank tomorrow at 10")).toBe(false);
  });
  it("'I'm free' or 'I'm bored' asks for one now; 'I'm free tomorrow at 5' does not", () => {
    for (const text of ["I'm free", "im bored", "I'm free now", "I have some free time", "what should I do now?"]) expect(saysFree(text)).toBe(true);
    expect(saysFree("I'm free tomorrow at 5")).toBe(false);
  });
  const items = [
    { id: 1, title: "Watch: Instagram Masterclass", created_at: iso("2026-11-12T10:00"), duration_minutes: 240 },
    { id: 2, title: "Watch: Mosseri AI setup", created_at: iso("2026-11-14T10:00"), duration_minutes: 45 },
    { id: 3, title: "Read the grammar book", created_at: iso("2026-11-10T10:00"), duration_minutes: 60 },
  ];
  it("one that fits the free time, never offered in the last two days, the longest waiting first", () => {
    expect(pickFreeItem(items, { minutesFree: 90, hour: 20, stats: {}, offeredSince: new Set() })?.id).toBe(3);
    expect(pickFreeItem(items, { minutesFree: 90, hour: 20, stats: {}, offeredSince: new Set([3]) })?.id).toBe(2);
    expect(pickFreeItem(items, { minutesFree: 300, hour: 20, stats: {}, offeredSince: new Set([3]) })?.id).toBe(1);
  });
  it("the kinds he accepts at this time of day come first", () => {
    const stats = { "watch:evening": { offered: 4, accepted: 4 }, "study:evening": { offered: 4, accepted: 0 } };
    expect(pickFreeItem(items, { minutesFree: 90, hour: 20, stats, offeredSince: new Set() })?.id).toBe(2);
  });
  it("reads as the spec says", () => {
    expect(freeTimeText(items[0], at("2026-11-21T18:00"), at("2026-11-21T13:30"))).toBe("You're free until **18:00**. Want to finally watch **Instagram Masterclass**? It's been waiting 9 days.");
  });
});

describe("d) Follow-up ladder", () => {
  const task = (id: number, title: string, due: string | null, extra: Partial<OpenTask> = {}): OpenTask => ({ id, title, due_at: due ? iso(due) : null, status: due ? "todo" : "inbox", updated_at: iso("2026-11-10T10:00"), ...extra });
  it("days slipped by the day he lives: after midnight, yesterday's task has not slipped yet", () => {
    expect(slippedDays(task(1, "Call the bank", "2026-11-20T10:00"), at("2026-11-21T08:00"))).toBe(1);
    expect(slippedDays(task(1, "Call the bank", "2026-11-20T10:00"), at("2026-11-21T01:00"))).toBe(0);
    expect(slippedDays(task(1, "Call the bank", "2026-11-17T10:00"), at("2026-11-20T09:00"))).toBe(3);
  });
  it("missed today: two hours past, open, not prayers, not followed up yet", () => {
    const list = [task(1, "Call the bank", "2026-11-21T10:00"), task(2, "Post stories", "2026-11-21T11:00"), task(3, "Dhuhr", "2026-11-21T09:00", { kind: "prayer" }), task(4, "Workout", "2026-11-21T10:00")];
    expect(missedToday(list, at("2026-11-21T12:30"), new Set([4])).map((t) => t.id)).toEqual([1]);
    // Rig, 21 Nov 03:30: tasks due at 00:30 and 01:00, after midnight, are missed today too.
    const night = [task(5, "Call the bank", "2026-11-21T00:30"), task(6, "Post stories", "2026-11-21T01:00")];
    expect(missedToday(night, at("2026-11-21T03:30"), new Set()).map((t) => t.id)).toEqual([5, 6]);
  });
  it("the brief's '⚠️ Still open' and Sunday's review of the inbox (7 days untouched, never the Free Time list)", () => {
    const now = at("2026-11-22T19:00");
    const list = [task(1, "Call the bank", "2026-11-20T10:00"), task(2, "Buy notebook", null), task(3, "Watch masterclass", null, { free_time: true }), task(4, "New idea", null, { updated_at: iso("2026-11-21T10:00") })];
    expect(stillOpen(list, now).map((t) => t.id)).toEqual([1]);
    expect(staleInbox(list, now).map((t) => t.id)).toEqual([2]);
  });
});

describe("e) Notification budget, merged reminders, downtime", () => {
  it("reminders within 15 minutes go out as one", () => {
    const due = { id: 1, fire_at: iso("2026-11-21T10:00") };
    const others = [due, { id: 2, fire_at: iso("2026-11-21T10:10") }, { id: 3, fire_at: iso("2026-11-21T10:20") }];
    expect(mergeable(due, others).map((r) => r.id)).toEqual([2]);
  });
  it("ten minutes without a clean tick is downtime", () => {
    expect(downtime(iso("2026-11-21T09:10"), at("2026-11-21T10:40"))).toEqual({ from: at("2026-11-21T09:10"), minutes: 90 });
    expect(downtime(iso("2026-11-21T10:37"), at("2026-11-21T10:40"))).toBeUndefined();
  });
});

describe("b) Library: found by what he calls it", () => {
  const now = at("2026-11-21T12:00");
  const items: LibraryItem[] = [
    { source: "library", id: 1, kind: "link", url: "https://www.instagram.com/reel/Df-WBn2haF6/", title: "Ziyoda on Instagram", description: "Instagram reel", created_at: iso("2026-11-21T01:23") },
    { source: "library", id: 2, kind: "link", url: "https://youtu.be/w0H1-b044KY", title: "YouTube video", description: "YouTube video", created_at: iso("2026-11-21T01:31") },
    { source: "media", id: 7, kind: "photo", title: null, description: "Abdulla Jabborow · KUNLIK ME'YOR 4 100 kkal\nShows: a nutrition app screen", created_at: iso("2026-11-20T02:58") },
    { source: "library", id: 3, kind: "link", url: "https://youtu.be/SaiTtbRJwic", title: "THE Instagram Masterclass: How To Grow in 2027", description: "YouTube video", created_at: iso("2026-11-20T23:22") },
  ];
  it("'that Instagram video' is the reel, not the YouTube masterclass about Instagram", () => {
    expect(pickItem(items, "send me that Instagram video", now).found?.id).toBe(1);
  });
  it("'the photo I sent yesterday' is the nutrition app screenshot", () => {
    expect(pickItem(items, "the photo I sent yesterday", now).found?.id).toBe(7);
  });
  it("two that fit equally: he is asked, with their titles", () => {
    const twins: LibraryItem[] = [
      { source: "library", id: 10, kind: "link", url: "https://www.instagram.com/reel/AAA/", title: "Reel about hooks", description: null, created_at: iso("2026-11-21T09:00") },
      { source: "library", id: 11, kind: "link", url: "https://www.instagram.com/reel/BBB/", title: "Reel about hooks part 2", description: null, created_at: iso("2026-11-21T09:05") },
    ];
    const result = pickItem(twins, "send me the instagram reel about hooks", now);
    expect(result.found).toBeUndefined();
    expect(result.choices?.map((item) => item.id).sort()).toEqual([10, 11]);
  });
  it("nothing close: nothing found", () => {
    expect(pickItem(items, "the tiktok about cooking", now)).toEqual({});
  });
  it("labels and plain descriptions", () => {
    expect(itemLabel(items[0], now)).toBe("▶️ Ziyoda on Instagram · today");
    expect(describeUrl("https://www.instagram.com/reel/Df-WBn2haF6/?x=1")).toBe("Instagram reel");
    expect(describeUrl("https://youtu.be/w0H1-b044KY")).toBe("YouTube video");
  });
});

describe("b) Library: his own label is the key (21 Nov 20:21)", () => {
  const now = at("2026-11-21T20:21");
  const items: LibraryItem[] = [
    { source: "library", id: 1, kind: "link", url: "https://www.instagram.com/reel/Df6Ja3OR_PK/?jplx=x", title: "Sevara on Instagram", description: "i have to shoot this type of videos", task_id: 48, created_at: iso("2026-11-21T18:10") },
    { source: "media", id: 62, kind: "video", title: "Video for when I need motivation", note: "Video for when I need motivation", description: null, created_at: iso("2026-11-21T18:11") },
    { source: "media", id: 65, kind: "video", title: "ideas for my reels", note: "ideas for my reels", description: null, created_at: iso("2026-11-21T18:47") },
    { source: "media", id: 71, kind: "video", title: null, note: null, description: null, task_id: 50, created_at: iso("2026-11-21T19:17") },
  ];
  it("'Send me one video Like ideas for my reels' is the file he filed under that label", () => {
    expect(labelMatch(items, "Send me one video Like ideas for my reels").found?.id).toBe(65);
    expect(labelMatch(items, "send me ideas for reels").found?.id).toBe(65);
  });
  it("the correction names the label too, and the item just sent is never it", () => {
    expect(labelMatch(items, "No, I didn't mean this one. I meant the video which I sent it to you as the ideas for my reels.", ["library:1"]).found?.id).toBe(65);
    expect(labelMatch(items, "send me ideas for my reels", ["media:65"]).found).toBeUndefined();
  });
  it("'the video' is no label (the brain picks); a label's one distinctive word is ('the motivation video'); a page title is never his label", () => {
    expect(labelMatch(items, "send me the video")).toEqual({});
    expect(labelMatch(items, "send me the motivation video").found?.id).toBe(62);
    expect(rankItems(items, "send me the motivation video", now).map((item) => item.id)[0]).toBe(62);
    expect(labelMatch(items, "send me Sevara on Instagram")).toEqual({});
  });
  it("two files under one label: both offered, never one picked", () => {
    const twins: LibraryItem[] = [...items, { source: "media", id: 80, kind: "video", title: "ideas for my reels", note: "ideas for my reels", description: null, created_at: iso("2026-11-21T19:40") }];
    const result = labelMatch(twins, "send me ideas for my reels");
    expect(result.found).toBeUndefined();
    expect(result.choices?.map((item) => item.id).sort()).toEqual([65, 80]);
  });
  it("candidates: his label first, then the rest by fit (newest first among equals); the item he rejected left out", () => {
    expect(rankItems(items, "Send me one video Like ideas for my reels", now, ["library:1"]).map((item) => item.id)).toEqual([65, 71, 62]);
    expect(labelHit(items[2], "Send me one video Like ideas for my reels")).toBe(true);
    expect(labelHit(items[1], "Send me one video Like ideas for my reels")).toBe(false);
  });
  it("'No, I didn't mean this one', 'I meant the other', 'wrong one' are corrections; 'no problem' is not", () => {
    for (const text of ["No, I didn't mean this one.", "I meant the other video", "wrong one", "not that one", "no, not this", "that's not it"]) expect(isNotThatOne(text)).toBe(true);
    for (const text of ["no problem", "send me the one about hooks", "I mean it", "No, I didn't finish it"]) expect(isNotThatOne(text)).toBe(false);
  });
  it("the five photos of one forwarded post are one item; two files with their own labels stay apart", () => {
    const album: LibraryItem[] = [66, 67, 68, 69, 70].map((id) => ({ source: "media", id, kind: "photo", title: id === 68 ? "You know why a lot of people don’t feel truly fulfilled…" : null, description: "Shows: an autumn scene", task_id: 49, created_at: iso("2026-11-21T18:52") }));
    const grouped = groupAlbums([...items, ...album]);
    expect(grouped.map((item) => item.id)).toEqual([1, 62, 65, 71, 66]);
    expect(grouped[4].album).toBe(5);
    expect(itemLabel(grouped[4], now)).toBe("📰 5 photos (one forwarded post) · today");
    const pair: LibraryItem[] = [
      { source: "media", id: 90, kind: "photo", title: "hook ideas", description: null, created_at: iso("2026-11-21T10:00") },
      { source: "media", id: 91, kind: "photo", title: "caption ideas", description: null, created_at: iso("2026-11-21T10:00") },
    ];
    expect(groupAlbums(pair).map((item) => item.id)).toEqual([90, 91]);
  });
});
