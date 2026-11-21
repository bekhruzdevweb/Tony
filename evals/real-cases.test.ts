/**
 * Eval suite: real messages from his chat (19–20 Nov), replayed through
 * Tony's whole brain (handleMessage → think → tools → database) against an
 * in-memory copy of the schema. The model is scripted to repeat what it
 * actually did wrong that day (claims without a write, a lost link, a wrong
 * time, asking instead of acting, being unreachable), so each case checks
 * that Tony's own code now catches it.
 *
 * Runs with `npm test`, and before every build (`prebuild`): a failing case
 * stops the deploy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer, ChatMessage } from "../src/lib/brain/model";
import { createFakeDb, type FakeDb } from "./support/fake-db";

type Step = Answer | "FAIL";
const state = vi.hoisted(() => ({ db: undefined as unknown as FakeDb, script: [] as unknown[], calls: [] as { messages: ChatMessage[]; system?: string }[], depths: [] as (string | undefined)[] }));

vi.mock("../src/lib/db", () => ({
  requireDb: () => state.db.client,
  getDb: () => state.db.client,
  isDatabaseReady: async () => true,
}));
vi.mock("../src/lib/brain/model", async (original) => ({
  ...(await original<typeof import("../src/lib/brain/model")>()),
  chat: async (input: { messages: ChatMessage[]; depth?: string; system?: unknown }) => {
    state.calls.push({ messages: structuredClone(input.messages), system: JSON.stringify(input.system ?? "") });
    state.depths.push(input.depth);
    const step = state.script.shift() as Step | undefined;
    if (step === undefined) throw new Error("eval: the scripted model has no more answers");
    if (step === "FAIL") throw new Error("model unreachable (scripted)");
    return step;
  },
}));

const { handleMessage, UNAVAILABLE } = await import("../src/lib/brain/handle");
const { transcribeAudio } = await import("../src/lib/voice");
const { placeTask, runProposal } = await import("../src/lib/slots");
const { runTick } = await import("../src/lib/reminders");

// ── helpers ──────────────────────────────────────────────────────────────
let callId = 0;
/** The model calls tools (all in one turn). */
const tools = (...calls: [string, Record<string, unknown>][]): Answer => ({
  content: null,
  tool_calls: calls.map(([name, args]) => ({ id: `call_${++callId}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
});
/** The model answers in words. */
const says = (content: string): Answer => ({ content });

const at = (local: string) => new Date(`${local}:00+05:00`);
/** "2026-11-21T08:30" style local time of a stored timestamp. */
const local = (iso: unknown) => (typeof iso === "string" ? new Date(new Date(iso).getTime() + 5 * 3_600_000).toISOString().slice(0, 16) : null);

function task(row: Record<string, unknown>) {
  return state.db.insert("tasks", { status: row.due_at ? "todo" : "inbox", ...row, due_at: row.due_at ? at(String(row.due_at)).toISOString() : null });
}
const tasks = () => state.db.rows("tasks") as Record<string, unknown>[];
const byTitle = (title: string) => tasks().find((row) => row.title === title)!;
const replies = (handled: Awaited<ReturnType<typeof handleMessage>>) =>
  handled.map((item) =>
    item.kind === "thought" ? item.thought.reply : item.kind === "failed" || item.kind === "link" || item.kind === "placed" ? item.reply : item.kind === "media" ? `[media ${item.ids.join(",")}]` : `[${item.kind}]`,
  );

async function run(message: string, now: string, script: Step[]) {
  vi.setSystemTime(at(now));
  state.script = [...script];
  const handled = await handleMessage(message, { now: () => new Date(), wait: async () => undefined });
  return { handled, replies: replies(handled), leftover: state.script.length };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // No real network in the evals: a page's title comes from this stand-in.
  vi.stubGlobal("fetch", async () => new Response(`<html><head><meta property="og:title" content="Stand-in page title"></head></html>`, { status: 200, headers: { "content-type": "text/html" } }));
  state.db = createFakeDb();
  state.db.insert("settings", {});
  for (const name of ["Teaching", "Content", "Health", "Personal"]) state.db.insert("projects", { name });
  state.calls = [];
  state.depths = [];
  state.script = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── 1. Verify after write; replies only from verified results ───────────
describe("1. Replies come only from verified writes", () => {
  it("17:32 'remind me to prepare for my lesson after half an hour': the model claimed the barber reminder without any tool call", async () => {
    task({ title: "Prepare for the lesson", due_at: "2026-11-20T17:30" });
    task({ title: "Call the barber", due_at: "2026-11-21T08:30" });
    const result = await run("Also remind me to prepare for my lesson after half an hour.", "2026-11-20T17:32", [
      says("Noted, sir. Barber reminder set for tomorrow, Saturday 21 November, at **08:30**."),
    ]);
    expect(result.replies[0]).not.toMatch(/set for|noted/i);
    expect(result.replies[0]).toMatch(/nothing has been changed/i);
  });

  it("22:48 'Presentation was for level elementary': the note did not save, and Tony says so instead of 'Corrected'", async () => {
    task({ title: "Make English File presentation", due_at: "2026-11-21T13:00" });
    state.db.faults.push({ table: "tasks", drop: ["notes"] });
    const id = byTitle("Make English File presentation").id;
    const result = await run("Presentation was for level elementary", "2026-11-20T22:48", [
      tools(["update_task", { id, notes: "English File Elementary, for the student from New York", reply: "Corrected, sir: the 13:00 presentation now notes Elementary." }]),
    ]);
    expect(result.replies[0]).not.toMatch(/corrected/i);
    expect(result.replies[0]).toMatch(/notes did not save/);
  });

  it("17:31 barber 08:30: confirmed from the stored task, which really moved", async () => {
    const barber = task({ title: "Call the barber", due_at: "2026-11-21T07:00" });
    const result = await run("tomorrow remind me to call the barber at 8.30 a.m. in the morning", "2026-11-20T17:31", [
      tools(["set_reminder", { task_id: barber.id, at: "2026-11-21T08:30", reply: "Noted, sir." }]),
    ]);
    expect(local(byTitle("Call the barber").due_at)).toBe("2026-11-21T08:30");
    expect(result.replies[0]).toMatch(/Call the barber.*08:30/);
  });
});

// ── 2. Several requests: split, handle each, confirm each ───────────────
describe("2. Several requests in one message", () => {
  it("17:31 'remind this one after 20 minutes? And also, tomorrow … the barber at 8.30': both happen, each confirmed", async () => {
    const prep = task({ title: "Prepare for the lesson", due_at: "2026-11-20T17:30" });
    const barber = task({ title: "Call the barber", due_at: "2026-11-21T07:00" });
    const result = await run(
      "Can you remind this one after 20 minutes? And also, tomorrow remind me to call the barber at 8.30 a.m. in the morning.",
      "2026-11-20T17:31",
      [tools(["update_task", { id: prep.id, due_at: "2026-11-20T17:51" }]), tools(["set_reminder", { task_id: barber.id, at: "2026-11-21T08:30" }])],
    );
    expect(result.handled).toHaveLength(2);
    expect(local(byTitle("Prepare for the lesson").due_at)).toBe("2026-11-20T17:51");
    expect(local(byTitle("Call the barber").due_at)).toBe("2026-11-21T08:30");
    expect(result.replies[0]).toMatch(/Prepare for the lesson.*17:51/);
    expect(result.replies[1]).toMatch(/Call the barber.*08:30/);
    // His message is in the history once, whole.
    expect(state.db.rows("messages").filter((row) => row.role === "user")).toHaveLength(1);
    // The second request is handled on its own, knowing the whole message.
    expect(JSON.stringify(state.calls[1].messages.at(-1))).toContain("request 2");
  });

  it("22:36 'Tomorrow: presentation at 13:00 and the Zoom tutorial at 18:00. Also move IELTS prep to 10:00.'", async () => {
    const ielts = task({ title: "Preparation for IELTS exam", due_at: "2026-11-21T10:30" });
    const presentation = task({ title: "English File presentation" });
    const zoom = task({ title: "Zoom app tutorial" });
    const result = await run("Tomorrow: presentation at 13:00 and the Zoom tutorial at 18:00. Also move IELTS prep to 10:00.", "2026-11-20T22:36", [
      tools(["update_task", { id: presentation.id, due_at: "2026-11-21T13:00" }], ["update_task", { id: zoom.id, due_at: "2026-11-21T18:00" }]),
      // The model picks the wrong time for the second request: his time stands.
      tools(["update_task", { id: ielts.id, due_at: "2026-11-21T10:30" }]),
    ]);
    expect(result.handled).toHaveLength(2);
    expect(local(byTitle("English File presentation").due_at)).toBe("2026-11-21T13:00");
    expect(local(byTitle("Zoom app tutorial").due_at)).toBe("2026-11-21T18:00");
    expect(local(byTitle("Preparation for IELTS exam").due_at)).toBe("2026-11-21T10:00");
  });

  it("22:38 'clean the chat and send me the overdue task': the clean runs in code, the list comes from the brain", async () => {
    task({ title: "Challenge: post 4 images", due_at: "2026-11-20T08:00" });
    const result = await run("Can you clean the chat and send me the overdue task which I could not complete today?", "2026-11-20T22:38", [
      tools(["list_tasks", { day: "overdue" }]),
      says("One overdue, sir:\n- [ ] Challenge: post 4 images"),
    ]);
    expect(result.handled.map((item) => item.kind)).toEqual(["clean", "thought"]);
    expect(result.replies[1]).toContain("Challenge: post 4 images");
    expect(result.replies[1]).not.toMatch(/filter|tool/i);
    // The history keeps taking turns: his message, the clean, then the list.
    expect(state.db.rows("messages").map((row) => row.role)).toEqual(["user", "tony", "tony"]);
  });
});

// ── 3. The model unreachable: his words are never saved as a task ────────
describe("3. When the AI fails", () => {
  it("00:01 'can you schedule them by yourself…': retried once, then an apology; no task made of his words", async () => {
    const before = tasks().length;
    const result = await run("Well, can you schedule them by yourself, like optimize, like depending on their priorities? Yeah.", "2026-11-20T00:01", ["FAIL", "FAIL"]);
    expect(result.replies).toEqual([UNAVAILABLE]);
    expect(UNAVAILABLE).toBe("I didn't catch that, sir.");
    expect(tasks()).toHaveLength(before);
    expect(state.calls).toHaveLength(2);
    // Logged, with his words, for the record.
    const logged = state.db.rows("events").find((row) => row.kind === "ai_failure");
    expect((logged?.detail as { text?: string } | undefined)?.text).toContain("schedule them by yourself");
  });

  it("recovers on the retry", async () => {
    const result = await run("add buy notebook", "2026-11-20T12:00", ["FAIL", tools(["add_task", { title: "Buy notebook" }])]);
    expect(byTitle("Buy notebook").status).toBe("inbox");
    expect(result.replies[0]).toMatch(/Buy notebook.*inbox/);
    expect(state.db.rows("messages").filter((row) => row.role === "user")).toHaveLength(1);
  });
});

// ── 4. Every link and detail from the first message ─────────────────────
describe("4. Nothing from his first message is lost", () => {
  it("00:59 podcast: the YouTube link is kept in the task's notes", async () => {
    await run("https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi tmr remind me to watch this podcast and take notes at 2 p.m", "2026-11-20T00:59", [
      tools(["add_task", { title: "Watch podcast and take notes", due_at: "2026-11-21T14:00" }]),
    ]);
    const podcast = byTitle("Watch podcast and take notes");
    expect(podcast.notes).toContain("https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi");
    // At 00:59 he had not slept yet: "tmr" is Friday 20 (the night rule), not Saturday.
    expect(local(podcast.due_at)).toBe("2026-11-20T14:00");
  });

  it("22:46 'for the student from New York', 'elementary': kept even when the model's title drops them", async () => {
    await run("Make a presentation for the English File elementary book for the student from New York", "2026-11-20T22:46", [tools(["add_task", { title: "Make a presentation" }])]);
    const notes = String(byTitle("Make a presentation").notes);
    expect(notes).toContain("New York");
    expect(notes).toContain("elementary");
  });

  it("22:49 stories about the app, the club and the grammar series: saved as parts, nothing duplicated into notes", async () => {
    await run("Post stories about the new app I'm building, the upcoming speaking club and the grammar series", "2026-11-20T22:49", [
      tools(["add_task", { title: "Post stories", subtasks: ["the new app I'm building", "the upcoming speaking club", "the grammar series"] }]),
    ]);
    const stories = byTitle("Post stories");
    expect(state.db.rows("subtasks").filter((row) => row.task_id === stories.id)).toHaveLength(3);
    expect(stories.notes).toBeNull();
  });
});

// ── 5. Voice notes in English, Uzbek or Russian ─────────────────────────
describe("5. Transcription stays in en/uz/ru", () => {
  it("22:57: a short note heard as Hungarian is read again, and the confident English reading wins", async () => {
    vi.useRealTimers();
    process.env.STT_API_KEY = "stt-test";
    const asked: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: FormData }) => {
      const language = init.body.get("language") as string | null;
      asked.push(language);
      const body =
        language === null
          ? { text: "Az új csapat köszönhető, hogy", language: "hungarian", segments: [{ avg_logprob: -0.9 }] }
          : language === "en"
            ? { text: "I said also tell me which podcast I have to watch.", language: "en", segments: [{ avg_logprob: -0.18 }] }
            : { text: "…", language, segments: [{ avg_logprob: -1.6 }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      expect(await transcribeAudio(new ArrayBuffer(8), "voice.ogg", "audio/ogg")).toBe("I said also tell me which podcast I have to watch.");
      expect(asked.sort()).toEqual([null, "en", "ru", "uz"].sort());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an English note is read once", async () => {
    vi.useRealTimers();
    process.env.STT_API_KEY = "stt-test";
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ text: "Remind me to work out at 6 pm", language: "english", segments: [{ avg_logprob: -0.1 }] }), { status: 200 });
    });
    try {
      expect(await transcribeAudio(new ArrayBuffer(8), "voice.ogg", "audio/ogg")).toBe("Remind me to work out at 6 pm");
      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── 6. Act first ────────────────────────────────────────────────────────
describe("6. Act first: inbox, his times, one question", () => {
  it("22:32 two tasks for tomorrow, no times: saved to the inbox instead of 'What time should I set?'", async () => {
    const result = await run(
      "can you remind me to make a presentation for english file elementary for international students tomorrow",
      "2026-11-20T22:32",
      [
        says("Of course, sir: the English File Elementary presentation. What time should I set?"),
        tools(["add_task", { title: "English File Elementary presentation", notes: "For international students" }]),
      ],
    );
    const presentation = byTitle("English File Elementary presentation");
    expect(presentation.status).toBe("inbox");
    expect(presentation.due_at).toBeNull();
    // He named a day but no time, and nothing in his routine says when he prepares lessons:
    // one question, with real free slots tomorrow as buttons. Nothing placed by itself.
    const thought = result.handled[0].kind === "thought" ? result.handled[0].thought : undefined;
    expect(thought?.slot?.kind).toBe("ask");
    expect(thought?.slot?.taskId).toBe(presentation.id);
    expect(result.replies[0].match(/\?/g)).toHaveLength(1);
    expect(result.replies[0]).not.toMatch(/inbox/);
    expect(thought?.planId).toBeUndefined();
  });

  it("23:09 'I have to update my fitness app…' with no time: inbox, no proposal, no draft", async () => {
    const result = await run("Also one task. I have to update my fitness app by adding new features such as bodyweight exercise, pull-up challenge and etc.", "2026-11-20T23:09", [
      tools(["add_task", { title: "Update fitness app", notes: "New features: bodyweight exercise, pull-up challenge" }]),
    ]);
    const app = byTitle("Update fitness app");
    expect(app.status).toBe("inbox");
    expect(app.due_at).toBeNull();
    expect(state.db.rows("plans")).toHaveLength(0);
    expect(result.replies[0]).toMatch(/inbox/);
  });

  it("12:22 'conduct the lesson at 6.30 p.m.': the model wrote 18:00, his 18:30 stands", async () => {
    await run("I have to conduct the lesson at 6.30 p.m.", "2026-11-20T12:22", [tools(["add_task", { title: "Conduct the lesson", due_at: "2026-11-20T18:00" }])]);
    expect(local(byTitle("Conduct the lesson").due_at)).toBe("2026-11-20T18:30");
  });

  it("17:32 'prepare for my lesson after half an hour': the model counted from the wrong time, his half hour stands", async () => {
    const prep = task({ title: "Prepare for the lesson", due_at: "2026-11-20T17:30" });
    await run("remind me to prepare for my lesson after half an hour", "2026-11-20T17:32", [tools(["update_task", { id: prep.id, due_at: "2026-11-20T18:30" }])]);
    expect(local(byTitle("Prepare for the lesson").due_at)).toBe("2026-11-20T18:02");
  });

  it("12:14 'a message at 1, 1 and a half p.m.': two times, both kept as given", async () => {
    await run("I have to send a message at 1, 1 and a half p.m. to the one teacher on Instagram.", "2026-11-20T12:14", [
      tools(["add_task", { title: "Message the teacher on Instagram", due_at: "2026-11-20T13:00" }]),
    ]);
    const message = byTitle("Message the teacher on Instagram");
    expect(local(message.due_at)).toBe("2026-11-20T13:00");
  });

  it("one question per reply at most", async () => {
    const result = await run("what should I do first tomorrow?", "2026-11-20T21:00", [
      says("The IELTS preparation at **10:00**, sir. Shall I move the reading before it? Or would you rather plan the whole day?"),
    ]);
    expect(result.replies[0].match(/\?/g)).toHaveLength(1);
  });

  it("15:39 'what can u do' is a question, never a task", async () => {
    await run("what can u do", "2026-11-20T15:39", [says("I can handle most of your day, sir: tasks, reminders, plans and voice notes.")]);
    expect(tasks()).toHaveLength(0);
  });
});

// ── Phase: how Tony decides (20 Nov, 23:14–23:39) ────────────────────────
const thoughtOf = (result: Awaited<ReturnType<typeof run>>, index = 0) => {
  const item = result.handled[index];
  return item.kind === "thought" ? item.thought : undefined;
};
const hhmm = (iso: unknown) => (typeof iso === "string" ? local(iso)!.slice(11) : null);
const said = (role: "user" | "tony", text: string, when: string) => state.db.insert("messages", { role, text, channel: "telegram", created_at: at(when).toISOString() });
const routineRow = (patch: Record<string, unknown>) => state.db.insert("routine", { id: true, ...patch });
const linkOffer = (url: string, title: string, when: string) => state.db.insert("offers", { kind: "link", payload: { url, title, summary: "" }, created_at: at(when).toISOString() });

// ── Change 1 (21 Nov): a day without a time is ALWAYS asked, best first, with a reason ──
type AskSlot = { kind: "ask"; taskId: number; day: string; options: { at: Date; why?: string }[]; taken?: string };
const askOf = (result: Awaited<ReturnType<typeof run>>, index = 0) => {
  const slot = thoughtOf(result, index)?.slot;
  expect(slot?.kind).toBe("ask");
  return slot as AskSlot;
};
const timesOf = (slot: AskSlot) => slot.options.map((option) => hhmm(option.at.toISOString()));

describe("Change 1 · a day without a time: always asked, never picked", () => {
  it("content tomorrow, with content hours: asked; the first option is in them ('your content time'); nothing placed until his tap", async () => {
    routineRow({ content: "10:00–12:00" });
    const result = await run("I need to post stories tomorrow", "2026-11-20T21:00", [tools(["add_task", { title: "Post stories", day: "2026-11-21" }])]);
    const slot = askOf(result);
    expect(timesOf(slot)[0]).toBe("10:00");
    expect(slot.options[0].why).toBe("your content time");
    expect(slot.options.length).toBeGreaterThanOrEqual(2);
    expect(result.replies[0]).toMatch(/When tomorrow, Sat 21 Nov\? Best: \*\*10:00\*\*, your content time\./);
    expect(result.replies[0]).not.toMatch(/inbox|I'll put/);
    expect(result.replies[0].match(/\?/g)).toHaveLength(1);
    // Nothing is placed until he taps one.
    expect(byTitle("Post stories").due_at).toBeNull();
    const tapped = await placeTask(slot.taskId, slot.options[0].at, { learn: true });
    expect(hhmm(byTitle("Post stories").due_at)).toBe("10:00");
    expect(tapped.text).toMatch(/Post stories.*10:00/);
  });

  it("23:20 'schedule it for upcoming Sunday afternoon or noon': the model's 13:00 is not his; asked, noon first", async () => {
    const result = await run(
      "Also, can you plan adding new features to my Telegram chatbox agent? Like features like tracking habits and new organization methods. And we can schedule it for upcoming Sunday afternoon or noon.",
      "2026-11-20T23:20",
      [tools(["add_task", { title: "Plan new chatbot agent features", due_at: "2026-11-22T13:00", notes: "Tracking habits and new organization methods" }])],
    );
    expect(byTitle("Plan new chatbot agent features").due_at).toBeNull();
    const slot = askOf(result);
    expect(slot.day).toBe("2026-11-22");
    expect(timesOf(slot)[0]).toBe("12:00");
    expect(slot.options[0].why).toBe("around noon, as you said");
  });

  it("23:20 'launch a course … upcoming Sunday. Maybe Sunday evening.': asked, an evening slot first, his words kept", async () => {
    const result = await run(
      "Also remind me to launch a course for level beginner students and elementary level students upcoming Sunday. Maybe Sunday evening.",
      "2026-11-20T23:20",
      [tools(["add_task", { title: "Launch beginner and elementary course", due_at: "2026-11-22T18:00" }])],
    );
    const slot = askOf(result);
    expect(slot.day).toBe("2026-11-22");
    expect(slot.options[0].why).toBe("in the evening, as you said");
    const first = Number(timesOf(slot)[0]!.slice(0, 2));
    expect(first).toBeGreaterThanOrEqual(17);
    expect(first).toBeLessThan(21);
    expect(result.replies[0]).not.toMatch(/inbox/);
  });

  it("#284 23:38 'save it as a task for me to watch in the Monday': no 15:00; ONE question, his video time first, the masterclass named as taken", async () => {
    routineRow({ learned: { watch: [1230, 1230, 1245] } });
    task({ title: "Watch: Instagram Masterclass", due_at: "2026-11-23T10:00", duration_minutes: 240 });
    said("user", "https://youtu.be/CN8c1edTCew?si=0iSbYmp_MFmdO_ZU", "2026-11-20T23:38");
    linkOffer("https://youtu.be/CN8c1edTCew?si=0iSbYmp_MFmdO_ZU", "Head of Instagram Reveals How the Top 1% Actually Work With AI", "2026-11-20T23:38");
    said("tony", "This is a YouTube video titled \"Head of Instagram Reveals How the Top 1% Actually Work With AI\", sir.", "2026-11-20T23:38");
    const result = await run("I want you to save it as a task for me to watch in the Monday.", "2026-11-20T23:38", [
      tools(["add_task", { title: "Watch: Mosseri AI setup", due_at: "2026-11-23T15:00" }]),
    ]);
    const mosseri = byTitle("Watch: Mosseri AI setup");
    expect(mosseri.due_at).toBeNull();
    expect(mosseri.notes).toContain("https://youtu.be/CN8c1edTCew");
    const slot = askOf(result);
    expect(timesOf(slot)[0]).toBe("20:30");
    expect(slot.options[0].why).toBe("you usually watch videos around 20:30");
    // Never inside the masterclass (10:00–14:00, with its gap).
    for (const option of slot.options) expect(option.at.getTime() + 30 * 60_000 <= at("2026-11-23T09:50").getTime() || option.at.getTime() >= at("2026-11-23T14:10").getTime()).toBe(true);
    expect(result.replies[0]).toContain("🔗 link");
    expect(result.replies[0]).toContain("10:00–14:00 is taken by **Watch: Instagram Masterclass**");
    expect(result.replies[0]).not.toMatch(/→/);
  });

  it("#284 again, when the link's [Task] button made the task first: update_task with the model's 15:00 is asked about too", async () => {
    const made = task({ title: "Read: YouTube video", notes: "https://youtu.be/CN8c1edTCew?si=0iSbYmp_MFmdO_ZU" });
    said("user", "https://youtu.be/CN8c1edTCew?si=0iSbYmp_MFmdO_ZU", "2026-11-20T23:38");
    said("tony", "This is a YouTube video titled \"Head of Instagram Reveals How the Top 1% Actually Work With AI\", sir. Use Save or Task below.", "2026-11-20T23:38");
    // The screenshot he shared at 23:25 carries numbers ("23:22", "4 HOURS"); they are not his time.
    state.db.rows("settings")[0].last_shared_text = "THE Instagram Masterclass: How To Grow in 2027\n4 HOURS\n\n23:22";
    state.db.rows("settings")[0].last_shared_at = at("2026-11-20T23:25").toISOString();
    const result = await run("I want you to save it as a task for me to watch in the Monday.", "2026-11-20T23:38", [
      tools(["update_task", { id: made.id, title: "Watch: Mosseri AI setup", due_at: "2026-11-23T15:00" }]),
    ]);
    expect(byTitle("Watch: Mosseri AI setup").due_at).toBeNull();
    expect(askOf(result).day).toBe("2026-11-23");
  });

  it("#293 Sat 00:58 'for tomorrow … my workout app is the main priority': Saturday 21 (the model said Sunday), asked with free coding slots", async () => {
    const app = task({ title: "Update fitness app", notes: "Add more bodyweight exercises in phase 1.", duration_minutes: 120 });
    const result = await run("for tomorrow adding a updates for my workout app is the main priority of today", "2026-11-21T00:58", [
      tools(["update_task", { id: app.id, day: "2026-11-22", priority: 1 }]),
    ]);
    const slot = askOf(result);
    expect(slot.day).toBe("2026-11-21");
    expect(result.replies[0]).toMatch(/When tomorrow, Sat 21 Nov\?/);
    for (const option of slot.options) expect(local(option.at.toISOString())!.slice(0, 10)).toBe("2026-11-21");
    expect(byTitle("Update fitness app").priority).toBe(1);
    expect(byTitle("Update fitness app").due_at).toBeNull();
  });

  it("'decide yourself for videos and podcasts': switched on, then the next video is placed with Tony's reason; 'ask me again' switches it off", async () => {
    routineRow({ learned: { watch: [1230, 1230] } });
    const on = await run("decide yourself for videos and podcasts, you don't need to ask me", "2026-11-20T21:00", [tools(["routine", { field: "decide", value: "videos and podcasts", on: true }])]);
    expect(state.db.rows("routine")[0].auto_kinds).toEqual(["watch"]);
    expect(on.replies[0]).toMatch(/videos and podcasts/);
    const placed = await run("watch the Mosseri video on Monday", "2026-11-20T21:01", [tools(["add_task", { title: "Watch: Mosseri AI setup", day: "2026-11-23" }])]);
    expect(thoughtOf(placed)?.slot).toMatchObject({ kind: "auto", why: "you usually watch videos around 20:30" });
    expect(hhmm(byTitle("Watch: Mosseri AI setup").due_at)).toBe("20:30");
    expect(placed.replies[0]).toMatch(/✓ \*\*Watch: Mosseri AI setup\*\* → Mon 23 Nov, \*\*20:30\*\*.*my pick: you usually watch videos around 20:30/);
    await run("ask me again for videos", "2026-11-20T21:02", [tools(["routine", { field: "decide", value: "videos", on: false }])]);
    expect(state.db.rows("routine")[0].auto_kinds).toEqual([]);
    const asked = await run("watch the masterclass recap on Tuesday", "2026-11-20T21:03", [tools(["add_task", { title: "Watch: masterclass recap", day: "2026-11-24" }])]);
    expect(askOf(asked).day).toBe("2026-11-24");
  });

  it("[✏️ Other time]: he types '20:30' and it is placed in code, no model call, and learned", async () => {
    const reel = task({ title: "Watch reel: humor plus education" });
    state.db.rows("settings")[0].pending_slot = { task_id: reel.id, day: "2026-11-24" };
    state.db.rows("settings")[0].pending_slot_at = at("2026-11-21T01:24").toISOString();
    const result = await run("20:30", "2026-11-21T01:25", []);
    expect(state.calls).toHaveLength(0);
    expect(result.handled[0].kind).toBe("placed");
    expect(local(byTitle("Watch reel: humor plus education").due_at)).toBe("2026-11-24T20:30");
    expect(result.replies[0]).toMatch(/Watch reel: humor plus education.*Tue 24 Nov, \*\*20:30\*\*/);
    expect((state.db.rows("routine")[0].learned as Record<string, number[]>).watch).toContain(1230);
    expect(state.db.rows("settings")[0].pending_slot).toBeNull();
  });

  it("[✏️ Other time] then a sentence, not a time: the brain handles it, told which task and day", async () => {
    const reel = task({ title: "Watch reel: humor plus education" });
    state.db.rows("settings")[0].pending_slot = { task_id: reel.id, day: "2026-11-24" };
    state.db.rows("settings")[0].pending_slot_at = at("2026-11-21T01:24").toISOString();
    await run("after my evening workout", "2026-11-21T01:25", [says("When does your workout end on Tuesday?")]);
    expect(state.calls).toHaveLength(1);
    const latest = state.calls[0].messages[state.calls[0].messages.length - 1].content as string;
    expect(latest).toMatch(/Watch reel: humor plus education/);
    expect(latest).toMatch(/2026-11-24/);
  });

  it("a 4-hour masterclass with no 4-hour gap on Monday: offered in two halves; his tap makes two tasks", async () => {
    for (const [time, minutes] of [["2026-11-23T08:00", 120], ["2026-11-23T12:30", 90], ["2026-11-23T16:30", 90], ["2026-11-23T20:30", 90]] as const) task({ title: `Busy ${time.slice(11)}`, due_at: time, duration_minutes: minutes });
    const result = await run("watch the Instagram masterclass on Monday, it's 4 hours", "2026-11-20T21:00", [tools(["add_task", { title: "Watch: Instagram Masterclass", day: "2026-11-23", duration: 240 }])]);
    const slot = thoughtOf(result)?.slot as { kind: string; taskId: number; parts: Date[]; minutes: number };
    expect(slot.kind).toBe("split");
    expect(slot.minutes).toBe(120);
    expect(result.replies[0]).toMatch(/won't fit in one go/);
    expect(result.replies[0]).toMatch(/2 h each/);
    const { splitTask } = await import("../src/lib/slots");
    await splitTask(slot.taskId, slot.parts);
    const halves = tasks().filter((row) => String(row.title).startsWith("Watch: Instagram Masterclass"));
    expect(halves.map((row) => row.title).sort()).toEqual(["Watch: Instagram Masterclass (1/2)", "Watch: Instagram Masterclass (2/2)"]);
    for (const half of halves) {
      expect(half.duration_minutes).toBe(120);
      expect(half.due_at).not.toBeNull();
    }
  });

  it("learns from what he finishes: two videos done at 21:40 (an hour each, so started 20:40); the next one is offered there first, on the quarter hour", async () => {
    const one = task({ title: "Watch podcast and take notes", due_at: "2026-11-21T20:00", duration_minutes: 60 });
    const two = task({ title: "Watch: Mosseri AI setup", due_at: "2026-11-22T20:00", duration_minutes: 60 });
    await run("done with the podcast", "2026-11-21T21:40", [tools(["complete_task", { id: one.id }])]);
    await run("watched the Mosseri video", "2026-11-22T21:40", [tools(["complete_task", { id: two.id }])]);
    expect((state.db.rows("routine")[0].learned as Record<string, number[]>).watch).toEqual([1240, 1240]);
    const result = await run("watch the reel on Tuesday", "2026-11-22T21:45", [tools(["add_task", { title: "Watch reel: humor plus education", day: "2026-11-24", duration: 30 }])]);
    const slot = askOf(result);
    expect(timesOf(slot)[0]).toBe("20:45");
    expect(slot.options[0].why).toBe("you usually watch videos around 20:40");
  });

  it("#309 'save this YouTube video and remind me to check it after three days and start doing it': the note keeps the link, never his instruction", async () => {
    said("user", "https://youtu.be/w0H1-b044KY?si=Ys74ZDWW8vlFUXYf", "2026-11-21T01:31");
    await run("Hey Tony, save this YouTube video and remind me to check it after three days and start doing it. Remind me about it.", "2026-11-21T01:32", [
      tools(["add_task", { title: "Check YouTube video, start doing it", day: "2026-11-24", notes: "https://youtu.be/w0H1-b044KY?si=Ys74ZDWW8vlFUXYf — check it and start doing it." }]),
    ]);
    const notes = String(byTitle("Check YouTube video, start doing it").notes);
    expect(notes).toContain("https://youtu.be/w0H1-b044KY");
    expect(notes).not.toMatch(/From your message|remind me/i);
  });

  it("not sure: ONE question with 2–3 real free slots that fit his routine (never in teaching hours, never on top of a task)", async () => {
    routineRow({ teaching: "Mon–Fri 14:00–18:00" });
    task({ title: "Watch: Instagram Masterclass", due_at: "2026-11-23T10:00", duration_minutes: 240 });
    const result = await run("add coding the bot features on Monday", "2026-11-20T23:40", [tools(["add_task", { title: "Code the bot features", day: "2026-11-23", duration: 90 }])]);
    const slot = askOf(result);
    expect(slot.options.length).toBeGreaterThanOrEqual(2);
    expect(slot.options.length).toBeLessThanOrEqual(3);
    for (const option of slot.options) {
      const start = option.at.getTime();
      const end = start + 90 * 60_000;
      // Clear of the masterclass (10:00–14:00) and of teaching (14:00–18:00), each with its gap.
      expect(end <= at("2026-11-23T09:50").getTime() || start >= at("2026-11-23T18:10").getTime()).toBe(true);
    }
    expect(result.replies[0].match(/\?/g)).toHaveLength(1);
  });

  it("learns from his moves: two content tasks moved to the morning, the next one is offered there first, in a free slot", async () => {
    const stories = task({ title: "Posting stories on Instagram", due_at: "2026-11-21T12:00", duration_minutes: 15 });
    const reel = task({ title: "Posting reel on Instagram", due_at: "2026-11-21T15:00", duration_minutes: 60 });
    await run("move posting stories to 10:00", "2026-11-20T21:00", [tools(["update_task", { id: stories.id, due_at: "2026-11-21T10:00" }])]);
    await run("and the reel to 10:30", "2026-11-20T21:01", [tools(["update_task", { id: reel.id, due_at: "2026-11-21T10:30" }])]);
    expect((state.db.rows("routine")[0].learned as Record<string, number[]>).content).toEqual([600, 630]);
    const result = await run("post a story about the speaking club tomorrow", "2026-11-20T21:02", [
      tools(["add_task", { title: "Post a story about the speaking club", day: "2026-11-21", duration: 15 }]),
    ]);
    const slot = askOf(result);
    expect(slot.options[0].why).toBe("you usually make content around 10:15");
    // 10:00–10:15 and 10:30–11:30 are taken: the nearest free start that fits, never on top of them.
    expect(timesOf(slot)[0]).toBe("09:30");
  });

  it("[📅 Tomorrow] on an inbox task asks with its free slots (no silent pick); on a timed task it keeps its own time of day", async () => {
    const { runAction } = await import("../src/lib/actions");
    const inbox = task({ title: "Call the bank", duration_minutes: 15 });
    const outcome = await runAction("tomorrow", Number(inbox.id), undefined, at("2026-11-20T21:00"));
    expect(byTitle("Call the bank").due_at).toBeNull();
    expect(outcome.text).toMatch(/When tomorrow, Sat 21 Nov\?/);
    const buttons = JSON.stringify(outcome.keyboard);
    expect(buttons).toMatch(/sl:at:/);
    expect(buttons).toMatch(/sl:other:/);
    const timed = task({ title: "Workout", due_at: "2026-11-20T18:00", duration_minutes: 60 });
    vi.setSystemTime(at("2026-11-20T21:00"));
    await runAction("tomorrow", Number(timed.id), undefined, at("2026-11-20T21:00"));
    expect(local(byTitle("Workout").due_at)).toBe("2026-11-21T18:00");
  });

  it("never 'inbox' and a time in one message, and the question names the day with its date", async () => {
    const result = await run("call the bank on Monday", "2026-11-20T21:00", [tools(["add_task", { title: "Call the bank", day: "2026-11-23", duration: 15 }])]);
    expect(result.replies[0]).toMatch(/When on Mon 23 Nov\?/);
    expect(result.replies[0]).not.toMatch(/inbox/);
  });
});

describe("Decide vs ask: his time is final, and never questioned", () => {
  it("'work out at 6 pm' on top of the Zoom tutorial: kept at 18:00, the clash stated, a free time offered", async () => {
    task({ title: "Shoot app tutorial on Zoom", due_at: "2026-11-21T18:00", duration_minutes: 60 });
    const result = await run("tomorrow remind me to work out at 6 pm", "2026-11-20T21:00", [tools(["add_task", { title: "Workout", due_at: "2026-11-21T18:00", persistent: true }])]);
    expect(hhmm(byTitle("Workout").due_at)).toBe("18:00");
    expect(result.replies[0]).toMatch(/⚠️ .*18:00\./);
    expect(result.replies[0]).not.toMatch(/\?/);
    expect(hhmm(thoughtOf(result)?.clash?.suggestAt?.toISOString())).toBe("19:15");
  });
});

describe("Style: say what you'll do, [✓] [✏️]", () => {
  it("23:28 'Buying a notebook removes this task.': a proposal, not 'mark done or delete?'; ✓ does it in code", async () => {
    const notebook = task({ title: "buy notebook", due_at: "2026-11-21T11:00" });
    const result = await run("Buying a notebook removes this task.", "2026-11-20T23:28", [
      tools(["propose", { say: "I'll remove **buy notebook**.", tool: "update_task", args: { id: notebook.id, status: "dropped" } }]),
    ]);
    const thought = thoughtOf(result)!;
    expect(result.replies[0]).toBe("I'll remove **buy notebook**.");
    expect(thought.proposal?.offerId).toBeGreaterThan(0);
    expect(byTitle("buy notebook").status).toBe("todo");
    const done = await runProposal(thought.proposal!.offerId);
    expect(byTitle("buy notebook").status).toBe("dropped");
    expect(done).toBe("✓ **buy notebook** removed");
    expect(await runProposal(thought.proposal!.offerId)).toBe("Already settled, sir.");
  });

  it("'I teach Mon-Fri from 2 to 6' goes into his routine, read back", async () => {
    const result = await run("I teach Mon-Fri from 2 to 6", "2026-11-20T21:00", [tools(["routine", { field: "teaching", value: "Mon-Fri 14:00-18:00" }])]);
    expect(state.db.rows("routine")[0].teaching).toBe("Mon–Fri 14:00–18:00");
    expect(result.replies[0]).toContain("🗓 Teaching: Mon–Fri 14:00–18:00");
  });
});

describe("Check-ins: 'remind me if I don't check it for 2 days' (23:17, ignored)", () => {
  const fakeBot = () => {
    const sent: { text: string; buttons: string[] }[] = [];
    const bot = {
      api: {
        sendMessage: async (_chat: number, text: string, extra?: { reply_markup?: { inline_keyboard?: { text: string }[][] } }) => {
          sent.push({ text, buttons: (extra?.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.text) });
          return { message_id: 900 + sent.length };
        },
      },
    };
    return { bot: bot as unknown as Parameters<typeof runTick>[0], sent };
  };

  it("inbox, no proposed plan, and a check-in in two days (moved out of the night)", async () => {
    const result = await run("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", "2026-11-20T23:17", [
      tools(["add_task", { title: "Buy a zippered shirt", notes: "Zamokli ko'ynak olish" }]),
    ]);
    // His Uzbek words are the title (Phase 2), never "Buy a zippered shirt".
    const shirt = byTitle("Zamokli ko'ynak olish");
    expect(shirt.status).toBe("inbox");
    expect(state.db.rows("plans")).toHaveLength(0);
    expect(thoughtOf(result)?.slot).toBeUndefined();
    const checkIn = state.db.rows("reminders").find((row) => row.task_id === shirt.id && row.kind === "stale")!;
    expect(checkIn.every_days).toBe(2);
    expect(local(checkIn.fire_at)).toBe("2026-11-23T10:00");
    expect(result.replies[0]).toContain("🔔 check-in after 2 untouched days");
  });

  it("fires only if untouched: sent with [✓ Done] [Tomorrow] [Drop], and comes back two days later", async () => {
    await run("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", "2026-11-20T23:17", [
      tools(["add_task", { title: "Buy a zippered shirt" }]),
    ]);
    vi.setSystemTime(at("2026-11-23T10:00"));
    const { bot, sent } = fakeBot();
    await runTick(bot, 42, new Date());
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Zamokli ko'ynak olish</b> has sat untouched for 2 days");
    expect(sent[0].buttons).toEqual(["✓ Done", "Tomorrow", "Drop"]);
    const next = state.db.rows("reminders").filter((row) => row.kind === "stale" && row.state === "scheduled");
    expect(next.map((row) => local(row.fire_at))).toEqual(["2026-11-25T10:00"]);
  });

  it("touched in between: no message; it waits two days from the touch", async () => {
    await run("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", "2026-11-20T23:17", [
      tools(["add_task", { title: "Buy a zippered shirt" }]),
    ]);
    vi.setSystemTime(at("2026-11-22T12:00"));
    await state.db.client.from("tasks").update({ notes: "the black one" }).eq("id", byTitle("Zamokli ko'ynak olish").id);
    vi.setSystemTime(at("2026-11-23T10:00"));
    const { bot, sent } = fakeBot();
    await runTick(bot, 42, new Date());
    expect(sent).toHaveLength(0);
    const waiting = state.db.rows("reminders").find((row) => row.kind === "stale" && row.state === "scheduled")!;
    expect(local(waiting.fire_at)).toBe("2026-11-24T12:00");
  });
});

describe("Links", () => {
  it("23:22 a link, then 'Remind me to watch this video in the upcoming Monday.': link in notes, a real title, shown in the reply; no invented 10:00", async () => {
    said("user", "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi", "2026-11-20T23:22");
    linkOffer("https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi", "THE Instagram Masterclass: How To Grow in 2027", "2026-11-20T23:22");
    said("tony", "I couldn't open that video, sir, so I can't tell you what it covers.", "2026-11-20T23:22");
    const result = await run("Remind me to watch this video in the upcoming Monday.", "2026-11-20T23:22", [tools(["add_task", { title: "Watch the video", due_at: "2026-11-23T10:00" }])]);
    const video = tasks().find((row) => String(row.title).startsWith("Watch: "))!;
    expect(video.title).toBe("Watch: THE Instagram Masterclass: How To Grow in 2027");
    expect(video.notes).toContain("https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi");
    expect(video.due_at).toBeNull();
    expect(result.replies[0]).toContain("🔗 link");
    expect(thoughtOf(result)?.slot?.kind).toBe("ask");
    expect(result.replies[0].match(/\?/g)).toHaveLength(1);
  });

  it("23:23 'Did you keep it with its link?': the model asks 'Shall I add the link…?'; Tony adds it instead and says so", async () => {
    said("user", "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi", "2026-11-20T23:22");
    vi.setSystemTime(at("2026-11-20T23:23"));
    task({ title: "Watch the video", due_at: "2026-11-23T10:00" });
    const result = await run("Did you keep it with its link or just watch the video?", "2026-11-20T23:23", [says("Shall I add the link to the notes of that task, sir?")]);
    expect(byTitle("Watch the video").notes).toContain("https://youtu.be/SaiTtbRJwic");
    expect(result.replies[0]).toContain("🔗 link");
    expect(result.replies[0]).not.toMatch(/\?/);
  });

  it("a forwarded event post says 20:00 but he says 'at 9': his time wins; with no time of his own, the post's time stands", async () => {
    const post = "\n\n[He forwarded this to you]\n«««\nA photo forwarded from the channel \"Barno Mukimova\"\n2 kun. 2 ta dars. 20-21-noyabr | 20:00!\n»»»";
    await run(`remind me to join this tomorrow at 9am${post}`, "2026-11-21T12:00", [tools(["add_task", { title: "Join the free lessons", due_at: "2026-11-22T20:00" }]), says("Set, sir.")]);
    expect(local(byTitle("Join the free lessons").due_at)).toBe("2026-11-22T09:00");
    await run(`remind me about this tomorrow${post}`, "2026-11-21T12:05", [tools(["add_task", { title: "Free lessons by Barno", due_at: "2026-11-22T20:00" }]), says("Set, sir.")]);
    expect(local(byTitle("Free lessons by Barno").due_at)).toBe("2026-11-22T20:00");
  });

  it("21 Nov 18:52: a forwarded album with an elevator notice ('…пользования лифтом') in a photo: the task keeps the model's title, not words from the photo", async () => {
    const message =
      "I have to write posts like that on my Telegram channel. Remind me. some day\n\n[He forwarded this to you]\n«««\nA photo forwarded from the channel \"Freya’s Talking\"\nText in the image: The only text is a notice in the elevator: \"...пользования лифтом\" (a Russian line, mirrored)\nShows: A person takes a mirror selfie in an elevator.\n(Saved. It can be attached to a task or filed under a label.)\n»»»\n\n[He forwarded this to you]\n«««\nA photo forwarded from the channel \"Freya’s Talking\"\nDirection matters more than hard work. Sooner or later I will find out. Show up at 20:00.\n»»»";
    await run(message, "2026-11-21T18:52", [
      tools(["add_task", { title: "Write Telegram posts like Freya's Talking", free_time: true, notes: "Short reflective posts on intentions, each with a calm photo." }]),
      says("Good format to copy, sir."),
    ]);
    const made = tasks()[0];
    expect(made.title).toBe("Write Telegram posts like Freya's Talking");
    // "Some day": the Free Time list; the 20:00 inside the forwarded post is not his time.
    expect(made.free_time).toBe(true);
    expect(made.due_at).toBeNull();
  });

  it("21 Nov 18:52: the post he forwarded with 'remind me some day' stays with that task (its photos and text), nothing older", async () => {
    const older = media({ kind: "photo", caption: "website colours", created_at: at("2026-11-21T10:00").toISOString() });
    const album = [
      media({ kind: "photo", caption: "", created_at: at("2026-11-21T18:52").toISOString() }),
      media({ kind: "photo", caption: "You know why a lot of people don’t feel truly fulfilled having achieved their goals?", created_at: at("2026-11-21T18:52").toISOString() }),
      media({ kind: "photo", caption: "", created_at: at("2026-11-21T18:52").toISOString() }),
    ];
    const message =
      "I have to write posts like that on my Telegram channel. Remind me. some day\n\n[He forwarded this to you]\n«««\nA photo forwarded from the channel \"Freya’s Talking\"\nYou know why a lot of people don’t feel truly fulfilled having achieved their goals?\n(Saved. It can be attached to a task or filed under a label.)\n»»»";
    const result = await run(message, "2026-11-21T18:53", [
      tools(["add_task", { title: "Write Telegram posts like Freya's Talking", free_time: true }]),
      says("Good format to copy, sir."),
    ]);
    const made = byTitle("Write Telegram posts like Freya's Talking");
    expect(state.db.rows("media").filter((row) => row.task_id === made.id).map((row) => row.id)).toEqual(album.map((row) => row.id));
    expect(state.db.rows("media").find((row) => row.id === older.id)!.task_id ?? null).toBeNull();
    expect(result.replies[0]).toMatch(/🖼 3 photos/);
  });

  it("23:25 'send me the video to just to check': the brain picks it from his library by meaning; code sends the exact link (21 Nov: word matching mixed links up)", async () => {
    task({ title: "Watch: Instagram Masterclass (Brock Johnson)", due_at: "2026-11-23T10:00", notes: "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi" });
    // The link only lived in the task's notes: it joins the library (library:1), named by its task, and the brain sees it.
    const result = await run("send me the video to just to check", "2026-11-20T23:25", [tools(["library", { action: "send", items: ["library:1"] }]), says("Here it is, sir.")]);
    const kept = state.db.rows("library").find((row) => String(row.url).includes("SaiTtbRJwic"))!;
    expect(kept.id).toBe(1);
    expect(kept.title).toBe("Watch: Instagram Masterclass (Brock Johnson)");
    expect(state.calls[0].system).toContain("library:1 ▶️ Watch: Instagram Masterclass (Brock Johnson)");
    const thought = result.handled[0].kind === "thought" ? result.handled[0].thought : undefined;
    expect(thought?.sendItems).toEqual(["library:1"]);
    // Something really is being sent, so "Here it is" stays; the link itself is never typed by the model.
    expect(result.replies[0]).toBe("Here it is, sir.");
  });

  it("a link from four messages ago is not attached to an unrelated task (rig, 21 Nov: the YouTube link landed on 'Buy a zippered shirt')", async () => {
    said("user", "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi", "2026-11-20T23:22");
    said("tony", "A masterclass on Instagram growth, sir.", "2026-11-20T23:22");
    said("user", "send me tasks for tomorrow", "2026-11-20T23:28");
    said("tony", "Nine tomorrow, sir.", "2026-11-20T23:28");
    await run("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", "2026-11-20T23:30", [
      tools(["add_task", { title: "Buy a zippered shirt", notes: "Zamokli ko'ynak olish" }]),
    ]);
    expect(String(byTitle("Zamokli ko'ynak olish").notes ?? "")).not.toContain("youtu");
  });

  it("a link sent with the task: kept in its notes and shown ('✓ Watch: … → Mon 23 Nov, 10:00 · 🔗 link')", async () => {
    const result = await run("https://youtu.be/CN8c1edTCew watch this on Monday at 10", "2026-11-20T23:40", [tools(["add_task", { title: "Watch this video", due_at: "2026-11-23T10:00" }])]);
    const video = tasks()[0];
    expect(video.notes).toContain("https://youtu.be/CN8c1edTCew");
    expect(video.title).toBe("Watch: Stand-in page title");
    expect(result.replies[0]).toMatch(/✓ \*\*Watch: Stand-in page title\*\* → Mon 23 Nov, \*\*10:00\*\* · 🔗 link$/);
  });
});

// ── Phase 1, round two (275 messages audited, 21 Nov) ────────────────────
const { recentChanges, undoChange } = await import("../src/lib/history");
const { memoryList, forgetFact } = await import("../src/lib/memory");
const { useOffer } = await import("../src/lib/offers");
const media = (row: Record<string, unknown>) => state.db.insert("media", { file_id: `FILE_${state.db.rows("media").length + 1}`, ...row });
const FIRST_LINK = "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi";
const SECOND_LINK = "https://www.youtube.com/watch?v=Ch4Sl0POBhU (Caleb Ralston, How to Build a Personal Brand, 6h 22min)";

describe("Phase 1 · sends: the original at once, never a claim without it", () => {
  it("15:41 'can you send it to me with this image?': the brain sees the screenshot in his library and sends exactly that one (no keyword search of every file)", async () => {
    const website = task({ title: "Add this feature to website", status: "done", due_at: "2026-11-20T09:30" });
    const photo = media({ kind: "photo", task_id: website.id, caption: "add this feature to webstie", description: "Abdulla Jabborow\nKUNLIK ME'YOR 4 100 kuniga kkal\nShows: a nutrition app screen with daily targets", created_at: at("2026-11-20T02:58").toISOString() });
    // Another saved photo that shares words ("website"): it must not go out too.
    media({ kind: "photo", caption: "website colours I like", created_at: at("2026-11-20T03:10").toISOString() });
    const result = await run("If you remember I sent you a one-post like add this feature to my website, can you send it to me with this image?", "2026-11-20T15:41", [
      tools(["library", { action: "send", items: [`media:${photo.id}`] }]),
      says("Here it is, sir."),
    ]);
    expect(state.calls[0].system).toContain(`media:${photo.id} 🖼 add this feature to webstie`);
    const thought = result.handled[0].kind === "thought" ? result.handled[0].thought : undefined;
    expect(thought?.sendItems).toEqual([`media:${photo.id}`]);
  });

  it("22:39 'where it is picture tho?' with nothing sent: 'Here it is, sir' is never said", async () => {
    const result = await run("where it is picture tho?", "2026-11-20T22:39", [says("Here it is, sir, the picture about adding a feature to your website.")]);
    expect(result.replies[0]).not.toMatch(/here it is/i);
  });
});

describe("Phase 1 · notes appended, history kept, /undo", () => {
  it("23:08 'it is the podcast which i should wtch': the new link is added, the first one kept (task 11 lost it)", async () => {
    const podcast = task({ title: "Watch podcast and take notes", due_at: "2026-11-21T14:00", notes: FIRST_LINK });
    const result = await run("it is the podcast which i should wtch the one i told", "2026-11-20T23:08", [tools(["update_task", { id: podcast.id, notes: SECOND_LINK }])]);
    const notes = String(byTitle("Watch podcast and take notes").notes);
    expect(notes).toContain(FIRST_LINK);
    expect(notes).toContain("https://www.youtube.com/watch?v=Ch4Sl0POBhU");
    expect(result.replies[0]).toContain("🔗 link");
  });

  it("/undo lists the last changes in his words and puts one back exactly", async () => {
    const podcast = task({ title: "Watch podcast and take notes", due_at: "2026-11-21T14:00", notes: FIRST_LINK });
    await run("it is the podcast which i should wtch the one i told", "2026-11-20T23:08", [tools(["update_task", { id: podcast.id, notes: SECOND_LINK }])]);
    await run("move the podcast to Monday at 10", "2026-11-20T23:09", [tools(["update_task", { id: podcast.id, due_at: "2026-11-23T10:00" }])]);
    const changes = await recentChanges(10);
    expect(changes[0].text).toBe("**Watch podcast and take notes**: moved from Sat 21 Nov 14:00 to Mon 23 Nov 10:00");
    expect(changes[1].text).toBe("**Watch podcast and take notes**: notes changed");
    const undone = await undoChange(changes[1].id);
    expect(undone).toMatch(/^↩ /);
    expect(byTitle("Watch podcast and take notes").notes).toBe(FIRST_LINK);
    // The later move stays, and an undone change is not offered again.
    expect(local(byTitle("Watch podcast and take notes").due_at)).toBe("2026-11-23T10:00");
    expect((await recentChanges(10)).some((change) => change.id === changes[1].id)).toBe(false);
  });

  it("'undo that' typed in words opens the same list, in code", async () => {
    const result = await run("undo that", "2026-11-20T23:10", []);
    expect(result.handled[0].kind).toBe("undo");
    expect(state.calls).toHaveLength(0);
  });
});

describe("Phase 1 · receipts show what is attached; Tony's list shows notes", () => {
  it("23:25 the masterclass screenshot attached: '✓ Watch: … → Mon 23 Nov, 10:00 · 🔗 link · 🖼 1 photo'", async () => {
    const watch = task({ title: "Watch: Instagram Masterclass", due_at: "2026-11-23T10:00", notes: FIRST_LINK });
    const shot = media({ kind: "photo", description: `${FIRST_LINK}\nTHE Instagram Masterclass: How To Grow in 2027`, created_at: at("2026-11-20T23:25").toISOString() });
    await state.db.client.from("settings").update({ last_shared_media_id: shot.id }).eq("id", true);
    const result = await run("THIS REEL WHICH I SENT YOU", "2026-11-20T23:26", [tools(["update_task", { id: watch.id, attach_shared: true }])]);
    expect(state.db.rows("media").find((row) => row.id === shot.id)?.task_id).toBe(watch.id);
    expect(result.replies[0]).toBe("✓ **Watch: Instagram Masterclass** → Mon 23 Nov, **10:00** · 🔗 link · 🖼 1 photo");
  });

  it("22:56 'So what I'm gonna post?': Tony's own list shows the notes and attachments", async () => {
    const stories = task({ title: "Posting stories on Instagram", due_at: "2026-11-21T12:00", notes: "Stories: the new app, the speaking club, the grammar series" });
    media({ kind: "photo", task_id: stories.id, description: "story draft" });
    await run("Posting stories on Instagram. So what I'm gonna post?", "2026-11-20T22:56", [
      tools(["list_tasks", { day: "tomorrow" }]),
      says("Three points, sir: the new app, the speaking club and the grammar series."),
    ]);
    const listed = JSON.stringify(state.calls[1].messages.at(-1));
    expect(listed).toContain("notes: Stories: the new app");
    expect(listed).toContain("1 photo");
  });
});

describe("Phase 1 · night rule: 00:00–05:00, 'tomorrow' is the day after he sleeps", () => {
  it("21 Nov 00:08 'send a message tomorrow to my teacher': Saturday 21, with weekday and date", async () => {
    const result = await run("Remind me to send a message tomorrow to my teacher about asking advice, launching a group.", "2026-11-21T00:08", [
      tools(["add_task", { title: "Message teacher about launching group", day: "2026-11-22", notes: "Ask for advice on launching a group" }]),
    ]);
    expect(thoughtOf(result)?.slot?.day).toBe("2026-11-21");
    expect(result.replies[0]).toContain("Sat 21 Nov");
  });

  it("20 Nov 00:59 'tmr … at 2 p.m': Friday 14:00, confirmed as 'tomorrow, Fri 20 Nov'", async () => {
    const result = await run(`${FIRST_LINK} tmr remind me to watch this podcast and take notes at 2 p.m`, "2026-11-20T00:59", [
      tools(["add_task", { title: "Watch podcast and take notes", due_at: "2026-11-21T14:00" }]),
    ]);
    expect(local(byTitle("Watch podcast and take notes").due_at)).toBe("2026-11-20T14:00");
    expect(result.replies[0]).toContain("tomorrow, Fri 20 Nov, **14:00**");
  });
});

describe("Phase 1 · memory: only facts he stated", () => {
  it("16:25 'It's Chorazm Honka': 'Khiva area' (never said) is refused; his own words are kept", async () => {
    const result = await run("Also, Tony, remind me my prayer times. Always. Okay? Take into account my location. It's Chorazm Honka.", "2026-11-20T16:25", [
      tools(["remember", { fact: "Lives in Khorezm (Khiva area); prayer times should follow that location." }]),
      tools(["remember", { fact: "Lives in Chorazm Honka; prayer times follow that location" }]),
    ]);
    expect(state.db.rows("memory").map((row) => row.fact)).toEqual(["Lives in Chorazm Honka; prayer times follow that location"]);
    expect(result.replies[0]).toContain("📝 Remembered: Lives in Chorazm Honka");
  });

  it("the Save button keeps the link and its title, never Tony's reply (rows 5 and 7); since phase b, in the library, not memory", async () => {
    const offer = state.db.insert("offers", {
      kind: "link",
      payload: { url: "https://www.youtube.com/watch?v=Ch4Sl0POBhU", title: "How to Build a Personal Brand (Full Course)", summary: "This is Caleb Ralston's 6 h 22 min course, sir." },
    });
    await useOffer("s", Number(offer.id), at("2026-11-20T23:07"));
    expect(state.db.rows("memory")).toHaveLength(0);
    expect(state.db.rows("library").map((row) => [row.title, row.url])).toEqual([["How to Build a Personal Brand (Full Course)", "https://www.youtube.com/watch?v=Ch4Sl0POBhU"]]);
    expect(JSON.stringify(state.db.rows("library"))).not.toMatch(/Caleb Ralston's 6 h/);
  });

  it("/memory lists what Tony keeps and forgets one on a tap", async () => {
    state.db.insert("memory", { fact: "I work out in the evenings", source: "user" });
    const wrong = state.db.insert("memory", { fact: "Lives in Khorezm (Khiva area)", source: "user" });
    expect((await memoryList()).map((row) => row.fact)).toEqual(["I work out in the evenings", "Lives in Khorezm (Khiva area)"]);
    expect(await forgetFact(Number(wrong.id))).toContain("Lives in Khorezm");
    expect((await memoryList()).map((row) => row.fact)).toEqual(["I work out in the evenings"]);
  });
});

describe("Phase 1 · never mention tools, filters or internal errors", () => {
  it("22:38 'send me the overdue task…': no 'overdue filter came back empty'", async () => {
    task({ title: "Challenge: post 4 images", due_at: "2026-11-20T08:00" });
    const result = await run("send me the overdue task which I could not complete today?", "2026-11-20T22:38", [
      tools(["list_tasks", { day: "overdue" }]),
      says("The overdue filter came back empty, though my list shows these five from today as unfinished:\n- [ ] Challenge: post 4 images"),
    ]);
    expect(result.replies[0]).not.toMatch(/filter/i);
    expect(result.replies[0]).toContain("Challenge: post 4 images");
  });
});

// ── Phase 2 (21 Nov): personality. His words stay, with one receipt line under them ──
describe("Phase 2 · a companion first: Tony's own words, one receipt line", () => {
  it("'add milk': one receipt line, nothing else, no 'sir'", async () => {
    const result = await run("add milk", "2026-11-20T21:00", [tools(["add_task", { title: "Milk", reply: "" }])]);
    expect(result.replies[0]).toBe("✓ **Milk** in the inbox");
  });

  it("17:31 the barber at 8.30: Tony's own words stay, the receipt under them", async () => {
    const result = await run("remind me to call the barber tomorrow at 8.30", "2026-11-20T17:31", [
      tools(["add_task", { title: "Call the barber", due_at: "2026-11-21T08:30", reply: "Early start: Saturday queues at the barber are brutal, so 8:30 is smart." }]),
    ]);
    expect(result.replies[0]).toBe("Early start: Saturday queues at the barber are brutal, so 8:30 is smart.\n\n✓ **Call the barber** → tomorrow, Sat 21 Nov, **08:30**");
  });

  it("his words never claim or state a time that is not stored: 'Done, sir, set for 9:00' goes, the receipt shows 08:30", async () => {
    const result = await run("remind me to call the barber tomorrow at 8.30", "2026-11-20T17:31", [
      tools(["add_task", { title: "Call the barber", due_at: "2026-11-21T08:30", reply: "Done, sir, set for 9:00. Good luck with the haircut!" }]),
    ]);
    expect(result.replies[0]).toBe("Good luck with the haircut!\n\n✓ **Call the barber** → tomorrow, Sat 21 Nov, **08:30**");
  });

  it("'help me plan my course launch': the whole answer reaches him, lists, headings and the closing question intact; no task, no buttons", async () => {
    const plan = [
      "Happy to, and it's a good moment for it: your beginner and elementary groups are the natural first buyers.",
      "",
      "### Who it's for",
      "- Beginners: what stops them speaking today?",
      "- Elementary: what do they want to be able to do in 8 weeks?",
      "",
      "### The offer",
      "1. One promise in a sentence, in Uzbek and English",
      "2. A fixed start date and a small cohort",
      "",
      "### Launch week",
      "- Monday: a reel for @behruznrl that shows the before and after",
      "- Wednesday: a free 30-minute lesson",
      "- Friday: doors close",
      "",
      "Which group do you want to fill first?",
    ].join("\n");
    const result = await run("help me plan my course launch", "2026-11-20T21:00", [says(plan)]);
    expect(result.replies[0]).toBe(plan);
    expect(tasks()).toHaveLength(0);
    const thought = thoughtOf(result)!;
    expect(thought.choices).toBeUndefined();
    expect(thought.slot).toBeUndefined();
  });

  it("23:17 'Zamokli ko'ynak olish …': his Uzbek words are the title, never 'Buy a zippered shirt'", async () => {
    await run("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", "2026-11-20T23:17", [
      tools(["add_task", { title: "Buy a zippered shirt", nudge_after_days: 2 }]),
    ]);
    expect(tasks().map((row) => row.title)).toEqual(["Zamokli ko'ynak olish"]);
  });

  it("a Russian task stays in Cyrillic", async () => {
    await run("Купить хлеб", "2026-11-20T21:00", [tools(["add_task", { title: "Buy bread" }])]);
    expect(tasks().map((row) => row.title)).toEqual(["Купить хлеб"]);
  });

  it("a long answer from Tony is remembered whole in the next turn (history was clipped at 280 characters)", async () => {
    const long = `Here is how I'd structure the series, sir. ${"Each episode takes one tense and one real situation from your students' week. ".repeat(10)}End.`;
    said("user", "how should I structure my grammar series?", "2026-11-20T20:58");
    said("tony", long, "2026-11-20T20:59");
    await run("and the second episode?", "2026-11-20T21:00", [says("The second one: the present perfect, told through travel stories.")]);
    const sent = state.calls[0].messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    expect(long.length).toBeGreaterThan(600);
    expect(sent).toContain(long);
  });

  it("advice gets more thought; 'add milk' does not", async () => {
    await run("help me plan my course launch", "2026-11-20T21:00", [says("Gladly. First: who is it for?")]);
    await run("add milk", "2026-11-20T21:01", [tools(["add_task", { title: "Milk" }])]);
    expect(state.depths).toEqual(["deep", undefined]);
  });
});

// ── 21 Nov 20:21: the video he labelled "ideas for my reels" ─────────────
const { libraryForPrompt } = await import("../src/lib/library");

describe("21 Nov 20:21 · the video he labelled 'ideas for my reels'", () => {
  const PROMO = "​​Спасибо, что пользуетесь - @SaveAsBot'ом";
  const atSecond = (local: string) => new Date(`${local}+05:00`).toISOString();
  /** His library as it stood at 20:21: the Sevara reel (18:10), the motivation video (18:11), the reels video (18:47), the Freya album (18:52), the 19:17 video. */
  const seed = () => {
    const shoot = task({ title: "Shoot videos like this reel", notes: "https://www.instagram.com/reel/Df6Ja3OR_PK/?jplx=dWZldTc4cTgzNzJp — the style of video I want to shoot." });
    state.db.insert("library", { kind: "link", url: "https://www.instagram.com/reel/Df6Ja3OR_PK/?jplx=dWZldTc4cTgzNzJp", title: "Sevara on Instagram", description: "i have to shoot this type of videos", source: "sent", task_id: shoot.id, created_at: at("2026-11-21T18:10").toISOString() });
    state.db.insert("library", { kind: "link", url: "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi", title: "THE Instagram Masterclass: How To Grow in 2027 (Brock Johnson)", description: "Brock Johnson's Instagram masterclass, about 4 hours", source: "sent", created_at: at("2026-11-20T23:22").toISOString() });
    const motivation = media({ kind: "video", caption: PROMO, note: "Video for when I need motivation", created_at: at("2026-11-21T18:11").toISOString() });
    const reels = media({ kind: "video", caption: PROMO, note: "ideas for my reels", created_at: at("2026-11-21T18:47").toISOString() });
    const posts = task({ title: "Write Telegram posts like Freya's Talking", free_time: true });
    const album = [0, 1, 2, 3, 4].map((index) =>
      media({ kind: "photo", caption: index === 2 ? "You know why a lot of people don’t feel truly fulfilled having achieved their goals?" : "", description: "Shows: an autumn scene", task_id: posts.id, created_at: at("2026-11-21T18:52").toISOString() }),
    );
    const watch = task({ title: "Watch saved video", due_at: "2026-11-22T12:00" });
    const later = media({ kind: "video", caption: PROMO, task_id: watch.id, created_at: at("2026-11-21T19:17").toISOString() });
    return { motivation, reels, album, later };
  };

  it("20:21 'Send me one video Like ideas for my reels': the file he filed under that label, sent by code; no model call, no guess", async () => {
    const { reels } = seed();
    const result = await run("Send me one video Like ideas for my reels", "2026-11-21T20:21", []);
    expect(result.handled[0]).toMatchObject({ kind: "send", refs: [`media:${reels.id}`], reply: "Here it is, sir." });
    expect(state.calls).toHaveLength(0);
  });

  it("20:21:31 'No, I didn't mean this one. I meant the video which I sent it to you as the ideas for my reels.': the labelled file, never the reel just sent", async () => {
    const { reels } = seed();
    state.db.insert("events", { kind: "sent_item", detail: { ref: "library:1", label: "▶️ Sevara on Instagram · today" }, created_at: atSecond("2026-11-21T20:21:14") });
    const result = await run("No, I didn't mean this one. I meant the video which I sent it to you as the ideas for my reels.", "2026-11-21T20:22", []);
    expect(result.handled[0]).toMatchObject({ kind: "send", refs: [`media:${reels.id}`] });
    expect(state.calls).toHaveLength(0);
  });

  it("a correction with no label after the wrong reel: the brain is told, the reel is refused if chosen again, and he gets the closest few as buttons, the reel not among them", async () => {
    const { reels, motivation, later } = seed();
    state.db.insert("events", { kind: "sent_item", detail: { ref: "library:1", label: "▶️ Sevara on Instagram · today" }, created_at: atSecond("2026-11-21T20:21:14") });
    const result = await run("No, not this one. The other video", "2026-11-21T20:22", [tools(["library", { action: "send", items: ["library:1"] }]), says("Which one do you mean, sir?")]);
    const latest = state.calls[0].messages.at(-1)?.content;
    expect(String(latest)).toContain("NOT the one");
    const refusal = state.calls[1].messages.filter((message) => message.role === "tool").map((message) => String(message.content)).join("\n");
    expect(refusal).toMatch(/not the one/);
    const thought = result.handled[0].kind === "thought" ? result.handled[0].thought : undefined;
    expect(thought?.sendItems).toEqual([]);
    const buttons = thought?.libraryChoices?.map((option) => option.data) ?? [];
    expect(buttons).toEqual(expect.arrayContaining([`lib:send:media:${reels.id}`, `lib:send:media:${motivation.id}`, `lib:send:media:${later.id}`]));
    expect(buttons).not.toContain("lib:send:library:1");
    expect(result.replies[0]).toBe("Which one do you mean, sir?");
  });

  it("the library list the brain sees: both labelled videos are there behind the 5-photo album and the newer video; the album is one line; his label leads 'Fits his words best'", async () => {
    const { reels, motivation, album } = seed();
    const text = (await libraryForPrompt(at("2026-11-21T20:21"), { message: "Send me one video Like ideas for my reels" })) ?? "";
    expect(text).toContain(`media:${reels.id} 🎞 ideas for my reels`);
    expect(text).toContain(`media:${motivation.id} 🎞 Video for when I need motivation`);
    expect(text).toContain(`media:${album[0].id} 📰 5 photos`);
    expect(text.split("\n").filter((line) => /^media:\d+ 🖼/.test(line))).toHaveLength(0);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Fits his words best/);
    expect(lines[1]).toContain(`media:${reels.id} 🎞 ideas for my reels`);
    expect(lines[1]).toMatch(/his label/i);
  });
});
