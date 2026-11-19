"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AppState } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { addMinutes, dayBounds, formatLongDate, formatTime, localDate, minuteOfDay } from "@/lib/time";
import { Empty, Icon, Section, TaskRow, isOpen } from "./ui";

export type ScreenProps = {
  state: AppState;
  now: Date;
  onOpen: (task: Task) => void;
  onToggle: (task: Task) => void;
};

const DAY_MS = 24 * 60 * 60_000;
const byDue = (a: Task, b: Task) => (a.due_at ?? "").localeCompare(b.due_at ?? "");

function greeting(now: Date) {
  const minute = minuteOfDay(now);
  return minute < 5 * 60 ? "Good night" : minute < 12 * 60 ? "Good morning" : minute < 18 * 60 ? "Good afternoon" : "Good evening";
}

function Title({ children, sub }: { children: string; sub?: string }) {
  return (
    <header className="pt-2">
      <h1 className="text-title leading-tight font-bold tracking-tight">{children}</h1>
      {sub && <p className="mt-1 text-sub text-secondary">{sub}</p>}
    </header>
  );
}

/** Greeting and date, what is overdue, today by time, and a quick-add bar. */
export function TodayScreen(props: ScreenProps & { onQuickAdd: (text: string) => Promise<void> }) {
  const { state, now, onOpen, onToggle, onQuickAdd } = props;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const { start, end } = dayBounds(now);
  const dated = state.tasks.filter((t) => t.due_at);
  const dueTime = (t: Task) => new Date(t.due_at!).getTime();
  // Overdue: every open task whose time has passed, from earlier days or
  // earlier today. A task he has started is in hand, so it stays under Today.
  const isOverdue = (t: Task) => isOpen(t) && t.status !== "in_progress" && dueTime(t) < now.getTime();
  const overdue = dated.filter(isOverdue).sort(byDue);
  const today = dated.filter((t) => !isOverdue(t) && dueTime(t) >= start.getTime() && dueTime(t) < end.getTime()).sort(byDue);
  const open = today.filter(isOpen);
  const finished = today.filter((t) => !isOpen(t));
  const row = { projects: state.projects, now, onOpen, onToggle };
  const attached = (task: Task) => state.media.some((item) => item.task_id === task.id);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    await onQuickAdd(text);
    setSending(false);
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <Title sub={formatLongDate(now)}>{`${greeting(now)}, sir`}</Title>
        {overdue.length > 0 && (
          <Section title={`Overdue · ${overdue.length}`} tone="overdue">
            {overdue.map((task) => (
              <TaskRow key={task.id} task={task} overdue when="full" attached={attached(task)} {...row} />
            ))}
          </Section>
        )}
        {open.length > 0 && (
          <Section title={`Today · ${open.length}`}>
            {open.map((task) => (
              <TaskRow key={task.id} task={task} attached={attached(task)} {...row} />
            ))}
          </Section>
        )}
        {finished.length > 0 && (
          <Section title="Done today">
            {finished.map((task) => (
              <TaskRow key={task.id} task={task} attached={attached(task)} {...row} />
            ))}
          </Section>
        )}
        {overdue.length + today.length === 0 && <Empty>Nothing on today, sir. A rare and agreeable state of affairs.</Empty>}
      </div>
      <form
        className="flex items-center gap-2 border-t border-hairline bg-background px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="h-11 min-w-0 flex-1 rounded-full bg-surface px-4 outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40"
          placeholder="Tell Tony: workout at 6 pm"
          aria-label="Quick add"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          enterKeyHint="send"
        />
        <button
          type="submit"
          aria-label="Add"
          disabled={!draft.trim() || sending}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-white transition-opacity disabled:opacity-40"
        >
          {Icon.send}
        </button>
      </form>
    </>
  );
}

/** Undated tasks, oldest first; anything older than three days carries its age. */
export function InboxScreen({ state, now, onOpen, onToggle }: ScreenProps) {
  const inbox = state.tasks.filter((t) => t.status === "inbox").sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <div className="flex-1 overflow-y-auto px-4 pb-6">
      <Title sub={inbox.length ? `${inbox.length} without a date` : undefined}>Inbox</Title>
      {inbox.length === 0 ? (
        <Empty>The inbox is empty, sir.</Empty>
      ) : (
        <Section title="Oldest first">
          {inbox.map((task) => {
            const days = Math.floor((now.getTime() - new Date(task.created_at).getTime()) / DAY_MS);
            return (
              <TaskRow key={task.id} task={task} projects={state.projects} now={now} when="none" badge={days > 3 ? `${days} days` : undefined} onOpen={onOpen} onToggle={onToggle} />
            );
          })}
        </Section>
      )}
    </div>
  );
}

/** The next seven days. Drag a task by its grip to move it to another day. */
export function UpcomingScreen(props: ScreenProps & { onMove: (task: Task, day: string) => void; onAddTo: (day: string) => void }) {
  const { state, now, onOpen, onToggle, onMove, onAddTo } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ task: Task; x: number; y: number; over?: string } | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => {
    const at = addMinutes(now, i * 24 * 60);
    const key = localDate(at);
    const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", weekday: "long", day: "numeric", month: "short" }).format(at);
    return { key, label: i === 0 ? `Today · ${weekday}` : i === 1 ? `Tomorrow · ${weekday}` : weekday };
  });
  const tasksOn = (key: string) =>
    state.tasks.filter((t) => t.due_at && isOpen(t) && localDate(new Date(t.due_at)) === key).sort(byDue);

  const dayAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest("[data-day]") as HTMLElement | null)?.dataset.day;

  const begin = (task: Task) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ task, x: event.clientX, y: event.clientY, over: localDate(new Date(task.due_at!)) });
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    // Near the top or bottom edge, scroll the list so far-off days can be reached.
    const box = scroller.current?.getBoundingClientRect();
    if (box && event.clientY < box.top + 70) scroller.current!.scrollBy(0, -14);
    if (box && event.clientY > box.bottom - 70) scroller.current!.scrollBy(0, 14);
    setDrag({ ...drag, x: event.clientX, y: event.clientY, over: dayAt(event.clientX, event.clientY) ?? drag.over });
  };
  const end = () => {
    if (!drag) return;
    const from = localDate(new Date(drag.task.due_at!));
    if (drag.over && drag.over !== from) onMove(drag.task, drag.over);
    setDrag(null);
  };

  return (
    <div ref={scroller} className={`flex-1 overflow-y-auto px-4 pb-6 ${drag ? "select-none" : ""}`}>
      <Title sub="The next seven days">Upcoming</Title>
      {days.map((day) => {
        const tasks = tasksOn(day.key);
        const target = drag?.over === day.key;
        return (
          <section key={day.key} data-day={day.key} className="mt-6">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <h2 className={`text-caption font-semibold tracking-wide uppercase ${target ? "text-primary" : "text-secondary"}`}>{day.label}</h2>
              <button type="button" aria-label={`Add a task on ${day.label}`} onClick={() => onAddTo(day.key)} className="-my-2 grid size-9 place-items-center text-secondary">
                <span className="scale-75">{Icon.plus}</span>
              </button>
            </div>
            <ul className={`divide-y divide-hairline overflow-hidden rounded-card bg-surface transition-shadow ${target ? "ring-2 ring-primary" : ""}`}>
              {tasks.length === 0 && <li className="px-4 py-3 text-sub text-secondary">{target ? "Drop here" : "Nothing planned"}</li>}
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  projects={state.projects}
                  now={now}
                  onOpen={onOpen}
                  onToggle={onToggle}
                  handle={
                    <button
                      type="button"
                      aria-label={`Drag ${task.title} to another day`}
                      onPointerDown={begin(task)}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={() => setDrag(null)}
                      className={`grid w-11 shrink-0 touch-none place-items-center text-secondary/60 ${drag?.task.id === task.id ? "text-primary" : ""}`}
                    >
                      {Icon.grip}
                    </button>
                  }
                />
              ))}
            </ul>
          </section>
        );
      })}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 max-w-[70vw] -translate-x-full -translate-y-1/2 truncate rounded-card bg-primary px-3 py-2 text-sub font-medium text-white shadow-xl"
          style={{ left: drag.x - 16, top: drag.y }}
        >
          {drag.task.title}
        </div>
      )}
    </div>
  );
}

/** The same conversation as Telegram, with a mic. */
export function ChatScreen(props: { state: AppState; onSend: (text: string) => Promise<void>; onVoice: (audio: Blob) => Promise<void> }) {
  const { state, onSend, onVoice } = props;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const count = state.messages.length;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, pending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || pending !== null) return;
    setDraft("");
    setPending(text);
    await onSend(text);
    setPending(null);
  };

  const toggleMic = async () => {
    if (recording) return recorder.current?.stop();
    setMicError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const audio = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (audio.size === 0) return;
        setPending("Voice note…");
        await onVoice(audio);
        setPending(null);
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setMicError("The microphone is not available. Allow it in the browser's settings.");
    }
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <Title sub="The same conversation as Telegram">Chat</Title>
        {count === 0 && pending === null && <Empty>Say something, sir. I am listening.</Empty>}
        <ol className="mt-4 space-y-2">
          {state.messages.map((message, index) => {
            const mine = message.role === "user";
            const previous = state.messages[index - 1];
            const newDay = !previous || localDate(new Date(previous.created_at)) !== localDate(new Date(message.created_at));
            return (
              <li key={message.id}>
                {newDay && <p className="my-3 text-center text-caption text-secondary">{formatLongDate(new Date(message.created_at))}</p>}
                <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[82%] rounded-[18px] px-3.5 py-2 ${mine ? "rounded-br-md bg-primary text-white" : "rounded-bl-md bg-surface"}`}>
                    <p className="text-body leading-snug break-words whitespace-pre-wrap">{message.text}</p>
                    <p className={`mt-0.5 text-right text-[11px] ${mine ? "text-white/70" : "text-secondary"}`}>{formatTime(new Date(message.created_at))}</p>
                  </div>
                </div>
              </li>
            );
          })}
          {pending !== null && (
            <li className="flex justify-end">
              <div className="max-w-[82%] rounded-[18px] rounded-br-md bg-primary/60 px-3.5 py-2 text-white">
                <p className="text-body leading-snug">{pending}</p>
              </div>
            </li>
          )}
          {pending !== null && (
            <li className="flex justify-start">
              <div className="rounded-[18px] rounded-bl-md bg-surface px-3.5 py-2 text-secondary">Tony is thinking…</div>
            </li>
          )}
        </ol>
        {micError && <p className="mt-3 text-center text-caption text-overdue">{micError}</p>}
        <div ref={bottom} />
      </div>
      <form
        className="flex items-center gap-2 border-t border-hairline bg-background px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <button
          type="button"
          onClick={toggleMic}
          aria-label={recording ? "Stop recording and send" : "Record a voice note"}
          aria-pressed={recording}
          disabled={pending !== null}
          className={`grid size-11 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-40 ${recording ? "animate-pulse bg-overdue text-white" : "bg-surface text-secondary"}`}
        >
          {Icon.mic}
        </button>
        <input
          className="h-11 min-w-0 flex-1 rounded-full bg-surface px-4 outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40"
          placeholder={recording ? "Recording… tap the mic to send" : "Message Tony"}
          aria-label="Message"
          value={draft}
          disabled={recording}
          onChange={(event) => setDraft(event.target.value)}
          enterKeyHint="send"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!draft.trim() || pending !== null}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-white transition-opacity disabled:opacity-40"
        >
          {Icon.send}
        </button>
      </form>
    </>
  );
}
