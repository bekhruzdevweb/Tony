"use client";

import type { ReactNode } from "react";
import type { AppProject } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { formatDue, formatTime } from "@/lib/time";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const Icon = {
  today: (
    <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M8 3v4M16 3v4M3.5 10h17" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
      <path d="M4 13.5 6.2 6a2 2 0 0 1 1.9-1.4h7.8A2 2 0 0 1 17.8 6L20 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 13.5h4.5a3.5 3.5 0 0 0 7 0H20" />
    </svg>
  ),
  upcoming: (
    <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M8 3v4M16 3v4M8 12h2M14 12h2M8 16h2" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
      <path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-3.9A8 8 0 1 1 20 12z" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" className="size-7" {...stroke} strokeWidth={2.2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" className="size-5" {...stroke} strokeWidth={2.2}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" className="size-5" {...stroke}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" className="size-5" {...stroke} strokeWidth={2}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" className="size-4" {...stroke} strokeWidth={2}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
  grip: (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
      <circle cx="9" cy="7" r="1.5" />
      <circle cx="15" cy="7" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="17" r="1.5" />
      <circle cx="15" cy="17" r="1.5" />
    </svg>
  ),
  repeat: (
    <svg viewBox="0 0 24 24" className="size-3.5" {...stroke} strokeWidth={2}>
      <path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" className="size-3.5" {...stroke} strokeWidth={2}>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 0 0 4 0" />
    </svg>
  ),
};

/** Priority colours for the round checkbox: P1 red, P2 amber, P3 Tony blue, P4 quiet. */
const PRIORITY_RING = ["", "border-overdue", "border-[#FF9F0A]", "border-primary", "border-secondary/50"];

export function isOpen(task: Task) {
  return task.status === "inbox" || task.status === "todo" || task.status === "in_progress";
}

export function TaskRow(props: {
  task: Task;
  projects: AppProject[];
  now: Date;
  /** What to show for the date: just the time, the full "tomorrow 09:00", or nothing. */
  when?: "time" | "full" | "none";
  overdue?: boolean;
  badge?: string;
  /** True when a photo or file is attached. */
  attached?: boolean;
  onOpen: (task: Task) => void;
  onToggle: (task: Task) => void;
  handle?: ReactNode;
}) {
  const { task, projects, now, when = "time", overdue, badge, attached, onOpen, onToggle, handle } = props;
  const done = !isOpen(task);
  const project = projects.find((p) => p.id === task.project_id);
  const due = task.due_at ? new Date(task.due_at) : undefined;

  return (
    <li className="flex min-h-11 items-stretch">
      <button
        type="button"
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        onClick={() => onToggle(task)}
        className="grid w-12 shrink-0 place-items-center"
      >
        <span
          className={`grid size-6 place-items-center rounded-full border-2 transition-colors ${
            done ? "check-pop border-done bg-done" : PRIORITY_RING[task.priority] ?? PRIORITY_RING[4]
          }`}
        >
          {done && (
            <svg viewBox="0 0 24 24" className="size-4 text-white" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <path className="check-draw" d="m6 12.5 4 4 8-9" />
            </svg>
          )}
        </span>
      </button>
      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 py-2.5 pr-3 text-left">
        <span className={`block text-body leading-snug ${done ? "text-secondary line-through" : ""}`}>{task.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-caption text-secondary">
          {due && when !== "none" && (
            <span className={overdue && !done ? "font-medium text-overdue" : ""}>
              {when === "full" ? formatDue(due, now) : formatTime(due)}
            </span>
          )}
          {task.status === "in_progress" && <span className="font-medium text-primary">Started</span>}
          {task.status === "skipped" && <span>Skipped</span>}
          {task.persistent && !done && <span className="inline-flex items-center gap-1 text-accent">{Icon.bell}Persistent</span>}
          {task.repeat_rule && <span className="inline-flex items-center gap-1">{Icon.repeat}{task.repeat_rule}</span>}
          {project && (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: project.color }} />
              {project.name}
            </span>
          )}
          {attached && <span aria-label="Has an attachment">📎</span>}
          {badge && <span className="rounded-full bg-overdue/12 px-2 py-px font-medium text-overdue">{badge}</span>}
        </span>
      </button>
      {handle}
    </li>
  );
}

export function Section({ title, tone, children }: { title: string; tone?: "overdue"; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className={`mb-1.5 px-1 text-caption font-semibold tracking-wide uppercase ${tone === "overdue" ? "text-overdue" : "text-secondary"}`}>
        {title}
      </h2>
      <ul className="divide-y divide-hairline overflow-hidden rounded-card bg-surface">{children}</ul>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-16 px-6 text-center text-sub text-secondary">{children}</p>;
}
