"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import type { AppProject } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { formatTime, localDate } from "@/lib/time";

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
  search: (
    <svg viewBox="0 0 24 24" className="size-5" {...stroke}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  ),
  filter: (
    <svg viewBox="0 0 24 24" className="size-5" {...stroke}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  ),
  hash: (
    <svg viewBox="0 0 24 24" className="size-4" {...stroke} strokeWidth={2}>
      <path d="M9 4 7 20M17 4l-2 16M4.5 9h16M3.5 15h16" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" className="size-3.5" {...stroke} strokeWidth={2}>
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
    </svg>
  ),
  pencil: (
    <svg viewBox="0 0 24 24" className="size-[18px]" {...stroke}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    </svg>
  ),
  comment: (
    <svg viewBox="0 0 24 24" className="size-[18px]" {...stroke}>
      <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor">
      <circle cx="6" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18" cy="12" r="1.6" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 24 24" className="size-4" {...stroke} strokeWidth={2}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" className="size-4" {...stroke} strokeWidth={2}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" className="size-4" {...stroke} strokeWidth={2}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className="size-5" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  plan: (
    <svg viewBox="0 0 24 24" className="size-5" {...stroke}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </svg>
  ),
};

/** Priority colours: P1 red, P2 orange, P3 Tony blue, P4 grey (as in Todoist, with Tony's blue). */
const PRIORITY = ["", "var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)"];

export function isOpen(task: Task) {
  return task.status === "inbox" || task.status === "todo" || task.status === "in_progress";
}

/** What a row's hover buttons and long-press menu can do; provided once by the app. */
export type RowActions = {
  edit: (task: Task, focus?: "notes") => void;
  date: (task: Task, choice: "today" | "tomorrow" | "next-week" | "none") => void;
  priority: (task: Task, priority: number) => void;
  remove: (task: Task) => void;
  /** Opens the long-press menu (phones). */
  menu: (task: Task) => void;
};
export const RowActionsContext = createContext<RowActions | null>(null);

const TZ = "Asia/Tashkent";
const monthDay = (at: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(at);
const weekdayName = (at: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(at);

/** The date chip: "18:00" or "Tomorrow 09:00" or "Nov 18", coloured like Todoist (red when overdue). */
function dateChip(due: Date, now: Date, overdue: boolean, showDay: boolean): { text: string; color: string } {
  const day = localDate(due);
  const today = localDate(now);
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const time = formatTime(due);
  const label = !showDay && days === 0 ? time : days === 0 ? `Today ${time}` : days === 1 ? `Tomorrow ${time}` : days > 1 && days < 7 ? `${weekdayName(due)} ${time}` : `${monthDay(due)} ${time}`;
  const color = overdue ? "var(--overdue)" : days === 0 ? "var(--today)" : days === 1 ? "var(--tomorrow)" : days > 1 && days < 7 ? "var(--week)" : "var(--secondary)";
  return { text: label, color };
}

export function TaskRow(props: {
  task: Task;
  projects: AppProject[];
  now: Date;
  /** What to show for the date: just the time, the full date, or nothing. */
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
  const actions = useContext(RowActionsContext);
  const [dateMenu, setDateMenu] = useState(false);
  const pressed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const done = !isOpen(task);
  const project = projects.find((p) => p.id === task.project_id);
  const due = task.due_at ? new Date(task.due_at) : undefined;
  const chip = due && when !== "none" ? dateChip(due, now, Boolean(overdue) && !done, when === "full") : undefined;
  const ring = PRIORITY[task.priority] ?? PRIORITY[4];
  const description = task.notes?.split("\n")[0];

  // Long-press (touch): the row's menu, as Todoist does on phones.
  const startPress = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse" || !actions) return;
    longPressed.current = false;
    pressed.current = setTimeout(() => {
      longPressed.current = true;
      actions.menu(task);
    }, 480);
  };
  const endPress = () => clearTimeout(pressed.current);

  return (
    <li className="group relative flex items-start border-b border-hairline" onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress} onContextMenu={(event) => actions && event.preventDefault()}>
      <button
        type="button"
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        onClick={() => onToggle(task)}
        className="grid w-10 shrink-0 place-items-center self-stretch pt-0 md:w-9"
      >
        <span
          className={`mt-[13px] grid size-[19px] place-items-center self-start rounded-full border-[1.6px] transition-colors ${done ? "check-pop" : ""}`}
          style={{ borderColor: done ? "var(--secondary)" : ring, background: done ? "var(--secondary)" : `color-mix(in srgb, ${ring} ${task.priority < 4 ? 12 : 0}%, transparent)` }}
        >
          {/* The tick shows on hover (wide screens) and when done. */}
          <svg viewBox="0 0 24 24" className={`size-3 ${done ? "text-white" : "text-transparent [@media(hover:hover)]:group-hover:text-[var(--ring)]"}`} style={{ "--ring": ring } as React.CSSProperties} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path className={done ? "check-draw" : ""} d="m6 12.5 4 4 8-9" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        onClick={() => (longPressed.current ? (longPressed.current = false) : onOpen(task))}
        className="min-w-0 flex-1 py-2.5 pr-2 text-left"
      >
        <span className={`block text-[15px] leading-snug md:text-[14px] ${done ? "text-secondary line-through" : ""}`}>{task.title}</span>
        {description && <span className="mt-0.5 block truncate text-[13px] text-secondary md:text-[12.5px]">{description}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px]">
          {chip && (
            <span className="inline-flex items-center gap-1" style={{ color: chip.color }}>
              {Icon.calendar}
              {chip.text}
            </span>
          )}
          {task.repeat_rule && <span className="inline-flex items-center gap-1 text-secondary">{Icon.repeat}{task.repeat_rule}</span>}
          {task.persistent && !done && <span className="inline-flex items-center gap-1 text-accent">{Icon.bell}</span>}
          {task.status === "in_progress" && <span className="font-medium text-primary">Started</span>}
          {task.duration_minutes ? <span className="text-secondary">{formatMinutes(task.duration_minutes)}</span> : null}
          {attached && <span aria-label="Has an attachment">📎</span>}
          {badge && <span className="rounded-full bg-overdue/12 px-2 py-px font-medium text-overdue">{badge}</span>}
          {/* The project, on the right, as Todoist shows it (hidden while the hover actions show). */}
          <span className={`ml-auto inline-flex items-center gap-0.5 text-secondary ${actions ? "md:group-hover:invisible" : ""}`}>
            {project ? project.name : task.due_at ? "" : "Inbox"}
            {(project || !task.due_at) && <span style={{ color: project?.color ?? "var(--secondary)" }}>{Icon.hash}</span>}
          </span>
        </span>
      </button>
      {/* Right side: the project, as Todoist shows it; on hover, the row's actions. */}
      <div className="flex shrink-0 items-start self-stretch">
        {actions && !done && (
          <span className="absolute top-1.5 right-1 hidden items-center rounded-md bg-background text-secondary md:group-hover:flex md:group-focus-within:flex">
            <IconButton label="Edit" onClick={() => actions.edit(task)}>{Icon.pencil}</IconButton>
            <IconButton label="Date" onClick={() => setDateMenu(!dateMenu)}>{Icon.calendar}</IconButton>
            <IconButton label="Comment" onClick={() => actions.edit(task, "notes")}>{Icon.comment}</IconButton>
            <IconButton label="More" onClick={() => actions.menu(task)}>{Icon.more}</IconButton>
            {dateMenu && <DateMenu onPick={(choice) => (setDateMenu(false), actions.date(task, choice))} onClose={() => setDateMenu(false)} />}
          </span>
        )}
        {handle}
      </div>
    </li>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-8 place-items-center rounded-md hover:bg-surface hover:text-ink">
      {children}
    </button>
  );
}

/** Today, Tomorrow, Next week, No date: the quick choices behind a row's date button. */
export function DateMenu({ onPick, onClose }: { onPick: (choice: "today" | "tomorrow" | "next-week" | "none") => void; onClose: () => void }) {
  const choices: [string, "today" | "tomorrow" | "next-week" | "none", string][] = [
    ["Today", "today", "var(--today)"],
    ["Tomorrow", "tomorrow", "var(--tomorrow)"],
    ["Next week", "next-week", "var(--week)"],
    ["No date", "none", "var(--secondary)"],
  ];
  return (
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-20 cursor-default" onClick={onClose} />
      <ul className="fade-in absolute top-9 right-0 z-30 w-44 overflow-hidden rounded-lg border border-hairline bg-background py-1 shadow-xl">
        {choices.map(([label, choice, color]) => (
          <li key={choice}>
            <button type="button" onClick={() => onPick(choice)} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[14px] text-ink hover:bg-surface">
              <span style={{ color }}>{Icon.calendar}</span>
              {label}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** "2h 30m", "45m". */
export function formatMinutes(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/** A section with a bold title and a thin rule, like Todoist; collapsible when `collapsible` is set. */
export function Section(props: {
  title: ReactNode;
  tone?: "overdue";
  action?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { title, tone, action, collapsible, defaultOpen = true, children } = props;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-5">
      <div className="flex items-center gap-1 border-b border-hairline pb-1.5">
        {collapsible && (
          <button type="button" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} onClick={() => setOpen(!open)} className={`-ml-1 grid size-6 place-items-center text-secondary transition-transform ${open ? "" : "-rotate-90"}`}>
            {Icon.down}
          </button>
        )}
        <h2 className={`flex-1 text-[14px] font-bold ${tone === "overdue" ? "text-ink" : "text-ink"}`}>{title}</h2>
        {action}
      </div>
      {open && <ul>{children}</ul>}
    </section>
  );
}

/** "+ Add task", inline at the end of a list, as in Todoist. */
export function AddTaskRow({ onAdd }: { onAdd: () => void }) {
  return (
    <li>
      <button type="button" onClick={onAdd} className="group flex h-11 w-full items-center gap-2 text-left text-[14px] text-secondary hover:text-primary">
        <span className="grid w-10 place-items-center text-primary md:w-9">
          <span className="grid size-[18px] place-items-center rounded-full transition-colors group-hover:bg-primary group-hover:text-white">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
              <path d="M12 6v12M6 12h12" />
            </svg>
          </span>
        </span>
        Add task
      </button>
    </li>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-16 px-6 text-center text-sub text-secondary">{children}</p>;
}
