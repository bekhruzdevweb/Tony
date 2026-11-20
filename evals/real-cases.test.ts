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
  handled.map((item) => (item.kind === "thought" ? item.thought.reply : item.kind === "failed" ? item.reply : "[clean]"));

async function run(message: string, now: string, script: Step[]) {
  vi.setSystemTime(at(now));
  state.script = [...script];
  const handled = await handleMessage(message, { now: () => new Date(), wait: async () => undefined });
  return { handled, replies: replies(handled), leftover: state.script.length };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  state.db = createFakeDb();
  state.db.insert("settings", {});
  for (const name of ["Teaching", "Content", "Health", "Personal"]) state.db.insert("projects", { name });
  state.calls = [];
  state.script = [];
});
afterEach(() => vi.useRealTimers());

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
    expect(result.replies[0]).not.toMatch(/\?/);
    // He named a day: a [Find a time] offer, nothing placed by itself.
    const thought = result.handled[0].kind === "thought" ? result.handled[0].thought : undefined;
    expect(thought?.slotOffer).toEqual({ day: "2026-11-21", taskIds: [presentation.id] });
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
