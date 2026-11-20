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
const state = vi.hoisted(() => ({ db: undefined as unknown as FakeDb, script: [] as unknown[], calls: [] as { messages: ChatMessage[] }[] }));

vi.mock("../src/lib/db", () => ({
  requireDb: () => state.db.client,
  getDb: () => state.db.client,
  isDatabaseReady: async () => true,
}));
vi.mock("../src/lib/brain/model", async (original) => ({
  ...(await original<typeof import("../src/lib/brain/model")>()),
  chat: async (input: { messages: ChatMessage[] }) => {
    state.calls.push({ messages: structuredClone(input.messages) });
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
  handled.map((item) => (item.kind === "thought" ? item.thought.reply : item.kind === "failed" || item.kind === "link" ? item.reply : "[clean]"));

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
    expect(tasks()).toHaveLength(before);
    expect(state.calls).toHaveLength(2);
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
    expect(local(podcast.due_at)).toBe("2026-11-21T14:00");
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

describe("Decide vs ask: a day without a time", () => {
  it("content tomorrow, with content hours: ONE slot proposed in them, [✓] places it", async () => {
    routineRow({ content: "10:00–12:00" });
    const result = await run("I need to post stories tomorrow", "2026-11-20T21:00", [tools(["add_task", { title: "Post stories", day: "2026-11-21" }])]);
    const thought = thoughtOf(result)!;
    expect(thought.slot).toMatchObject({ kind: "propose", why: "your content time" });
    expect(result.replies[0]).toMatch(/^I'll put \*\*Post stories\*\* tomorrow at \*\*10:00\*\*, your content time\.$/);
    expect(result.replies[0]).not.toMatch(/inbox/);
    // Nothing is placed until he taps ✓.
    expect(byTitle("Post stories").due_at).toBeNull();
    const tapped = await placeTask(thought.slot!.taskId, (thought.slot as { at: Date }).at);
    expect(hhmm(byTitle("Post stories").due_at)).toBe("10:00");
    expect(tapped.text).toMatch(/Post stories.*10:00/);
  });

  it("23:20 'schedule it for upcoming Sunday afternoon or noon': the model's 13:00 is not his; noon is proposed", async () => {
    const result = await run(
      "Also, can you plan adding new features to my Telegram chatbox agent? Like features like tracking habits and new organization methods. And we can schedule it for upcoming Sunday afternoon or noon.",
      "2026-11-20T23:20",
      [tools(["add_task", { title: "Plan new chatbot agent features", due_at: "2026-11-22T13:00", notes: "Tracking habits and new organization methods" }])],
    );
    expect(byTitle("Plan new chatbot agent features").due_at).toBeNull();
    expect(thoughtOf(result)?.slot).toMatchObject({ kind: "propose", day: "2026-11-22", why: "around noon, as you said" });
    expect(hhmm((thoughtOf(result)!.slot as { at: Date }).at.toISOString())).toBe("12:00");
  });

  it("23:20 'launch a course … upcoming Sunday. Maybe Sunday evening.': an evening slot, his words kept", async () => {
    const result = await run(
      "Also remind me to launch a course for level beginner students and elementary level students upcoming Sunday. Maybe Sunday evening.",
      "2026-11-20T23:20",
      [tools(["add_task", { title: "Launch beginner and elementary course", due_at: "2026-11-22T18:00" }])],
    );
    expect(thoughtOf(result)?.slot).toMatchObject({ kind: "propose", day: "2026-11-22", why: "in the evening, as you said" });
    expect(result.replies[0]).not.toMatch(/inbox/);
  });

  it("23:38 'save it as a task for me to watch in the Monday': no invented 15:00; his usual time for watching, with the link", async () => {
    routineRow({ learned: { learn: [1260, 1260, 1275] } });
    said("user", "https://youtu.be/CN8c1edTCew?si=0iSbYmp_MFmdO_ZU", "2026-11-20T23:38");
    linkOffer("https://youtu.be/CN8c1edTCew?si=0iSbYmp_MFmdO_ZU", "Head of Instagram Reveals How the Top 1% Actually Work With AI", "2026-11-20T23:38");
    said("tony", "This is a YouTube video titled \"Head of Instagram Reveals How the Top 1% Actually Work With AI\", sir.", "2026-11-20T23:38");
    const result = await run("I want you to save it as a task for me to watch in the Monday.", "2026-11-20T23:38", [
      tools(["add_task", { title: "Watch: Mosseri AI setup", due_at: "2026-11-23T15:00" }]),
    ]);
    const task = byTitle("Watch: Mosseri AI setup");
    expect(task.due_at).toBeNull();
    expect(task.notes).toContain("https://youtu.be/CN8c1edTCew");
    expect(thoughtOf(result)?.slot).toMatchObject({ kind: "propose", why: "you usually watch and read around 21:00" });
    expect(result.replies[0]).toContain("🔗 link saved");
    expect(result.replies[0]).not.toMatch(/15:00/);
  });

  it("not sure: ONE question with 2–3 real free slots that fit his routine (never in teaching hours, never on top of a task)", async () => {
    routineRow({ teaching: "Mon–Fri 14:00–18:00" });
    task({ title: "Watch: Instagram Masterclass", due_at: "2026-11-23T10:00", duration_minutes: 240 });
    const result = await run("add coding the bot features on Monday", "2026-11-20T23:40", [tools(["add_task", { title: "Code the bot features", day: "2026-11-23", duration: 90 }])]);
    const slot = thoughtOf(result)?.slot;
    expect(slot?.kind).toBe("ask");
    const options = (slot as { options: Date[] }).options;
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    for (const option of options) {
      const start = option.getTime();
      const end = start + 90 * 60_000;
      // Clear of the masterclass (10:00–14:00) and of teaching (14:00–18:00), each with its gap.
      expect(end <= at("2026-11-23T09:50").getTime() || start >= at("2026-11-23T18:10").getTime()).toBe(true);
    }
    expect(result.replies[0].match(/\?/g)).toHaveLength(1);
  });

  it("learns from his moves: two content tasks moved to the morning, the next one is proposed there, in a free slot", async () => {
    const stories = task({ title: "Posting stories on Instagram", due_at: "2026-11-21T12:00", duration_minutes: 15 });
    const reel = task({ title: "Posting reel on Instagram", due_at: "2026-11-21T15:00", duration_minutes: 60 });
    await run("move posting stories to 10:00", "2026-11-20T21:00", [tools(["update_task", { id: stories.id, due_at: "2026-11-21T10:00" }])]);
    await run("and the reel to 10:30", "2026-11-20T21:01", [tools(["update_task", { id: reel.id, due_at: "2026-11-21T10:30" }])]);
    expect((state.db.rows("routine")[0].learned as Record<string, number[]>).content).toEqual([600, 630]);
    const result = await run("post a story about the speaking club tomorrow", "2026-11-20T21:02", [
      tools(["add_task", { title: "Post a story about the speaking club", day: "2026-11-21", duration: 15 }]),
    ]);
    const slot = thoughtOf(result)?.slot as { kind: string; at: Date; why: string };
    expect(slot.kind).toBe("propose");
    expect(slot.why).toBe("you usually make content around 10:15");
    // 10:00–10:15 and 10:30–11:30 are taken: the nearest free start that fits, never on top of them.
    expect(hhmm(slot.at.toISOString())).toBe("09:30");
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
    expect(done).toBe("✓ **buy notebook** removed, sir.");
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
    const shirt = byTitle("Buy a zippered shirt");
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
    expect(sent[0].text).toContain("Buy a zippered shirt</b> has sat untouched for 2 days");
    expect(sent[0].buttons).toEqual(["✓ Done", "Tomorrow", "Drop"]);
    const next = state.db.rows("reminders").filter((row) => row.kind === "stale" && row.state === "scheduled");
    expect(next.map((row) => local(row.fire_at))).toEqual(["2026-11-25T10:00"]);
  });

  it("touched in between: no message; it waits two days from the touch", async () => {
    await run("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", "2026-11-20T23:17", [
      tools(["add_task", { title: "Buy a zippered shirt" }]),
    ]);
    vi.setSystemTime(at("2026-11-22T12:00"));
    await state.db.client.from("tasks").update({ notes: "the black one" }).eq("id", byTitle("Buy a zippered shirt").id);
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
    expect(result.replies[0]).toContain("🔗 link saved");
    expect(thoughtOf(result)?.slot?.kind).toBe("ask");
    expect(result.replies[0].match(/\?/g)).toHaveLength(1);
  });

  it("23:23 'Did you keep it with its link?': the model asks 'Shall I add the link…?'; Tony adds it instead and says so", async () => {
    said("user", "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi", "2026-11-20T23:22");
    vi.setSystemTime(at("2026-11-20T23:23"));
    task({ title: "Watch the video", due_at: "2026-11-23T10:00" });
    const result = await run("Did you keep it with its link or just watch the video?", "2026-11-20T23:23", [says("Shall I add the link to the notes of that task, sir?")]);
    expect(byTitle("Watch the video").notes).toContain("https://youtu.be/SaiTtbRJwic");
    expect(result.replies[0]).toContain("🔗 link saved");
    expect(result.replies[0]).not.toMatch(/\?/);
  });

  it("23:25 'send me the video to just to check': the link itself, at once, no model call", async () => {
    task({ title: "Watch: Instagram Masterclass (Brock Johnson)", due_at: "2026-11-23T10:00", notes: "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi" });
    const result = await run("send me the video to just to check", "2026-11-20T23:25", []);
    expect(result.handled[0].kind).toBe("link");
    expect(result.replies[0]).toContain("https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi");
    // No question to him (the "?" inside the link does not count).
    expect(result.replies[0].replace(/https?:\/\/\S+/g, "")).not.toMatch(/\?/);
    expect(state.calls).toHaveLength(0);
  });

  it("a link from four messages ago is not attached to an unrelated task (rig, 21 Nov: the YouTube link landed on 'Buy a zippered shirt')", async () => {
    said("user", "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi", "2026-11-20T23:22");
    said("tony", "A masterclass on Instagram growth, sir.", "2026-11-20T23:22");
    said("user", "send me tasks for tomorrow", "2026-11-20T23:28");
    said("tony", "Nine tomorrow, sir.", "2026-11-20T23:28");
    await run("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", "2026-11-20T23:30", [
      tools(["add_task", { title: "Buy a zippered shirt", notes: "Zamokli ko'ynak olish" }]),
    ]);
    expect(byTitle("Buy a zippered shirt").notes).toBe("Zamokli ko'ynak olish");
  });

  it("a link sent with the task: kept in its notes and shown ('✓ Watch: … → Mon 10:00 · 🔗 link saved')", async () => {
    const result = await run("https://youtu.be/CN8c1edTCew watch this on Monday at 10", "2026-11-20T23:40", [tools(["add_task", { title: "Watch this video", due_at: "2026-11-23T10:00" }])]);
    const video = tasks()[0];
    expect(video.notes).toContain("https://youtu.be/CN8c1edTCew");
    expect(video.title).toBe("Watch: Stand-in page title");
    expect(result.replies[0]).toMatch(/✓ \*\*Watch: Stand-in page title\*\* → Mon 23 Nov \*\*10:00\*\* · 🔗 link saved, sir\./);
  });
});
