/**
 * Phase 2: personality. Tony is a companion and advisor first, a task manager
 * second: his own words stay, with one receipt line under them; length fits
 * the question; buttons only for real task actions; "sir" now and then; his
 * Uzbek and Russian words stay as he wrote them. The pure pieces, from his
 * real messages.
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/lib/brain/prompt";
import { confirmationFor } from "../src/lib/brain/checks";
import { hisTitle, keepWords, oneQuestion, wantsThought } from "../src/lib/brain/reliability";

const at = (local: string) => new Date(`${local}:00+05:00`);
const NOW = at("2026-11-20T21:00");
const stable = buildSystemPrompt({ now: NOW, memory: [], tasks: [], projects: [] }).stable;

describe("The new prompt: a companion first", () => {
  it("drops the old caps and the butler", () => {
    expect(stable).not.toMatch(/Style: one short message/);
    expect(stable).not.toMatch(/up to 5 sentences|at most 2 short sentences/);
    expect(stable).not.toMatch(/Never end with "Shall I/);
    expect(stable).not.toMatch(/write nothing else/);
    expect(stable).not.toMatch(/butler in the style/);
    expect(stable).not.toMatch(/Call him "sir", once per reply/);
  });
  it("says who he is and who Tony is to him", () => {
    expect(stable).toMatch(/companion and advisor first/);
    expect(stable).toMatch(/task manager second/);
    expect(stable).toMatch(/"sir" now and then/);
    expect(stable).toMatch(/Khanqa/);
    expect(stable).not.toMatch(/in Tashkent\./);
    expect(stable).toMatch(/@behruznrl/);
    expect(stable).toMatch(/Length fits the question/);
  });
  it("keeps his Uzbek and Russian words, and buttons only for task actions", () => {
    expect(stable).toMatch(/Uzbek or Russian words stay exactly as he wrote them/);
    expect(stable).toMatch(/Buttons are only for real actions on tasks/);
    expect(stable).toMatch(/one receipt line/);
  });
  it("keeps every rule of how Tony decides (R, D, Phase 1, Change 1)", () => {
    expect(stable).toMatch(/He gave a time: use it exactly/);
    expect(stable).toMatch(/A day but no time/);
    expect(stable).toMatch(/decide yourself/);
    expect(stable).toMatch(/Never mention tools, filters, errors/);
    expect(stable).toMatch(/A question he asks you is never a task/);
  });
});

describe("Depth where it is asked for", () => {
  it("advice and discussion get more thought; a task does not", () => {
    expect(wantsThought("help me plan my course launch")).toBe(true);
    expect(wantsThought("What do you think about AI replacing teachers?")).toBe(true);
    expect(wantsThought("how can I grow my Instagram faster?")).toBe(true);
    expect(wantsThought("add milk")).toBe(false);
    expect(wantsThought("remind me to call the bank tomorrow at 10")).toBe(false);
    expect(wantsThought("what's left today?")).toBe(false);
  });
});

describe("His words stay; only what is false goes", () => {
  it("a claim and a wrong time go; the rest of what Tony said stays (barber, 17:31)", () => {
    expect(keepWords("Done, sir, set for 9:00. Good luck with the barber!", { times: ["08:30"] })).toBe("Good luck with the barber!");
    expect(keepWords("Early start: Saturday queues are brutal, so 8:30 is smart.", { times: ["08:30"] })).toBe("Early start: Saturday queues are brutal, so 8:30 is smart.");
  });
  it("lists, headings and questions in a long answer are untouched", () => {
    const plan = "### Who it's for\n- Beginners: what do they fear most?\n- Elementary: what do they want next?\n\n### Launch week\n1. Teaser reel on **Monday**\n2. Free lesson on **Wednesday**\n\nWhich of the two groups do you want to fill first?";
    expect(keepWords(plan, { times: [] })).toBe(plan);
    expect(oneQuestion(plan)).toBe(plan);
  });
  it("tools, filters and errors never reach him (22:38)", () => {
    expect(keepWords("The overdue filter came back empty. Two are still open from today.", { times: [] })).toBe("Two are still open from today.");
  });
});

describe("Receipts: one small line, no 'sir'", () => {
  it("one task", () => {
    expect(confirmationFor([{ tool: "add_task", title: "Call the barber", status: "todo", due_at: at("2026-11-21T08:30").toISOString() }], NOW)).toBe("✓ **Call the barber** → tomorrow, Sat 21 Nov, **08:30**");
    expect(confirmationFor([{ tool: "add_task", title: "Milk", status: "inbox", due_at: null }], NOW)).toBe("✓ **Milk** in the inbox");
  });
  it("several tasks: one line each, no 'Done, sir:' header", () => {
    const text = confirmationFor(
      [
        { tool: "add_task", title: "Presentation", status: "todo", due_at: at("2026-11-21T13:00").toISOString() },
        { tool: "add_task", title: "Zoom tutorial", status: "todo", due_at: at("2026-11-21T18:00").toISOString() },
      ],
      NOW,
    );
    expect(text).toBe("✓ **Presentation** → tomorrow, Sat 21 Nov, **13:00**\n✓ **Zoom tutorial** → tomorrow, Sat 21 Nov, **18:00**");
    expect(text).not.toMatch(/sir/);
  });
});

describe("His Uzbek and Russian words are the title (23:17: 'Zamokli ko'ynak olish' became 'Buy a zippered shirt')", () => {
  it("a translated title gives way to his words", () => {
    expect(hisTitle("Buy a zippered shirt", "Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days")).toBe("Zamokli ko'ynak olish");
    expect(hisTitle("Buy bread", "Купить хлеб завтра")).toBe("Купить хлеб");
  });
  it("his words already in the title, or an English message: unchanged", () => {
    expect(hisTitle("Zamokli ko'ynak olish", "Zamokli ko'ynak olish .put thist task to inbox")).toBe("Zamokli ko'ynak olish");
    expect(hisTitle("Call the barber", "remind me to call the barber tomorrow at 8.30")).toBe("Call the barber");
    expect(hisTitle("Update workout app", "for tomorrow adding a updates for my workout app is the main priority of today")).toBe("Update workout app");
  });
});

describe("21 Nov fixes", () => {
  it("keeps 'p.m.' inside its sentence (a lone '2 p.m.' was left at the top of a reply)", () => {
    expect(keepWords("2 p.m. has already passed today, so it is tomorrow. Good luck with the call!", { times: [] })).not.toMatch(/^2 p\.m\.$/m);
    expect(keepWords("2 p.m. has already passed today, so it is tomorrow. Good luck with the call!", { times: [] })).toContain("Good luck with the call!");
  });
});
