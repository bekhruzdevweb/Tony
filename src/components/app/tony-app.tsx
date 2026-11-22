"use client";

import Image from "next/image";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AppState } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { formatTime } from "@/lib/time";
import { Menu, type Theme } from "./menu";
import { BoardScreen, ChatScreen, FiltersScreen, FreeTimeScreen, HabitsScreen, InboxScreen, ProjectScreen, SearchScreen, TodayScreen, UpcomingScreen } from "./screens";
import { TaskSheet, type SheetTarget } from "./task-sheet";
import { Icon, RowActionsContext, isOpen, type RowActions } from "./ui";
import { splitToday } from "@/lib/today";
import { addMinutes, localDate } from "@/lib/time";
import { applyTelegramTheme, haptic, pushBack, tonyFetch, webApp } from "./telegram";
import { useTony } from "./use-tony";

type Tab = "today" | "inbox" | "freetime" | "upcoming" | "chat" | "search" | "filters" | "habits" | "board" | `project:${number}`;

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "today", label: "Today", icon: Icon.today },
  { id: "inbox", label: "Inbox", icon: Icon.inbox },
  { id: "upcoming", label: "Upcoming", icon: Icon.upcoming },
  { id: "chat", label: "Chat", icon: Icon.chat },
];

// The theme lives in localStorage (and on <html>, set before paint by the layout).
const THEME_EVENT = "tony-theme";
const subscribeTheme = (listen: () => void) => {
  window.addEventListener(THEME_EVENT, listen);
  return () => window.removeEventListener(THEME_EVENT, listen);
};
const readTheme = (): Theme => {
  const saved = localStorage.getItem("tony-theme");
  return saved === "light" || saved === "dark" ? saved : "system";
};

export function TonyApp({ initial }: { initial: AppState }) {
  const tony = useTony(initial);
  const { state, act, say, toast, signedOut } = tony;
  const [tab, setTab] = useState<Tab>("today");
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [menu, setMenu] = useState(false);
  const theme = useSyncExternalStore<Theme>(subscribeTheme, readTheme, () => "system");
  const now = new Date(state.now);

  useEffect(() => {
    // Inside Telegram the app wears Telegram's colours; elsewhere it can be installed.
    if (webApp()) return applyTelegramTheme();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  // Telegram's Back button closes the task sheet (the menu handles its own).
  const sheetOpen = sheet !== null;
  useEffect(() => (sheetOpen ? pushBack(() => setSheet(null)) : undefined), [sheetOpen]);

  useEffect(() => {
    if (signedOut) window.location.reload();
  }, [signedOut]);

  const changeTheme = (next: Theme) => {
    if (next === "system") {
      localStorage.removeItem("tony-theme");
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem("tony-theme", next);
      document.documentElement.dataset.theme = next;
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  const patch = (id: number, change: Partial<Task>) => (s: AppState) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...change } : t)),
  });

  /** The round checkbox: complete with a tick and a light haptic, or reopen. */
  const toggle = useCallback(
    (task: Task) => {
      if (isOpen(task)) {
        haptic("success");
        void act("complete_task", { id: task.id }, patch(task.id, { status: "done" }));
      } else {
        void act("update_task", { id: task.id, status: "todo" }, patch(task.id, { status: task.due_at ? "todo" : "inbox" }));
      }
    },
    [act],
  );

  const move = (task: Task, day: string) => {
    const due_at = `${day}T${formatTime(new Date(task.due_at!))}`;
    void act("update_task", { id: task.id, due_at });
  };

  const tell = async (text: string) => {
    const result = await act("say", { text });
    if (result.ok && result.reply && tab !== "chat") say(result.reply);
  };

  const voice = async (audio: Blob) => {
    try {
      const response = await tonyFetch("/api/app/voice", { method: "POST", headers: { "Content-Type": audio.type || "audio/webm" }, body: audio });
      const result = await response.json();
      if (result.state) tony.setState(result.state);
      if (!result.ok) say(result.error, "error");
    } catch {
      say("No connection. The voice note was not sent.", "error");
    }
  };

  // Row actions (hover on a wide screen, long-press on a phone): plain updates, no AI.
  const [rowMenu, setRowMenu] = useState<Task | null>(null);
  const [addingPart, setAddingPart] = useState<number | null>(null);
  useEffect(() => (rowMenu ? pushBack(() => setRowMenu(null)) : undefined), [rowMenu]);
  const redate = useCallback(
    (task: Task, choice: "today" | "tomorrow" | "next-week" | "none") => {
      if (choice === "none") return void act("update_task", { id: task.id, clear_due: true });
      const base = new Date(state.now);
      const offset = choice === "today" ? 0 : choice === "tomorrow" ? 1 : (8 - ((new Date(base.getTime() + 5 * 3_600_000).getUTCDay() + 6) % 7)) % 7 || 7;
      const day = localDate(addMinutes(base, offset * 24 * 60));
      const time = task.due_at ? formatTime(new Date(task.due_at)) : "09:00";
      // A time already gone today moves to the next hour instead.
      let due_at = `${day}T${time}`;
      if (choice === "today" && Date.parse(`${due_at}:00+05:00`) <= base.getTime()) {
        const next = addMinutes(base, 60 - (base.getMinutes() % 60));
        due_at = `${localDate(next)}T${formatTime(next)}`;
      }
      void act("update_task", { id: task.id, due_at });
    },
    [act, state.now],
  );
  const actions: RowActions = {
    edit: (task, focus) => setSheet({ task, focus }),
    date: redate,
    priority: (task, priority) => void act("update_task", { id: task.id, priority }, patch(task.id, { priority })),
    remove: (task) => void act("update_task", { id: task.id, status: "dropped" }, (s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== task.id) })),
    menu: (task) => {
      haptic("tap");
      setRowMenu(task);
    },
    parts: (taskId) => state.subtasks.filter((part) => part.task_id === taskId).sort((a, b) => a.position - b.position || a.id - b.id),
    tickPart: (part) => {
      haptic(part.done ? "tap" : "success");
      void act("tick_subtask", { id: part.id, done: !part.done }, (s) => ({ ...s, subtasks: s.subtasks.map((p) => (p.id === part.id ? { ...p, done: !part.done } : p)) })).then((result) => {
        if (result.ok && result.reply) say(result.reply);
      });
    },
    addPart: (taskId, title) => void act("add_subtask", { task_id: taskId, title }),
    adding: addingPart,
    setAdding: setAddingPart,
  };

  // The Plan board's moves and the Habits screen's check-in: plain code on the server, the outcome as a note.
  const lane = async (task: Task, to: "today" | "week" | "someday") => {
    haptic("tap");
    const result = await act("lane", { id: task.id, to });
    if (result.ok && result.reply) say(result.reply);
  };
  const checkHabit = async (taskId: number) => {
    haptic("success");
    const result = await act("check_habit", { id: taskId });
    if (result.ok && result.reply) say(result.reply);
  };

  const reschedule = async (to: "today" | "tomorrow") => {
    const result = await act("reschedule_overdue", { to });
    if (result.ok && result.reply) say(result.reply);
  };

  const screen = { state, now, onOpen: (task: Task) => setSheet({ task }), onToggle: toggle, onAdd: (target?: { day?: string; projectId?: number }) => setSheet(target ?? {}) };
  const open = state.tasks.filter(isOpen);
  const todayCount = (() => {
    const split = splitToday(state.tasks, now);
    return split.carried.length + split.timed.length;
  })();
  const projectId = tab.startsWith("project:") ? Number(tab.slice(8)) : undefined;

  return (
    <RowActionsContext.Provider value={actions}>
    <div className="flex h-dvh bg-background">
      {/* Wide screens (Telegram fullscreen, desktop): a sidebar, as in Todoist. */}
      <aside className="safe-top hidden w-[280px] shrink-0 flex-col border-r border-hairline bg-sidebar md:flex">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <button type="button" onClick={() => setMenu(true)} aria-label="Tony: settings" className="flex items-center gap-2.5 rounded-md py-1 pr-2 hover:bg-hairline">
            <Image src="/brand/avatar.png" alt="" width={28} height={28} priority className="size-7 rounded-full" />
            <span className="text-[14px] font-semibold">Tony</span>
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 pb-4 text-[14px]">
          <button type="button" onClick={() => setSheet({})} className="mb-1 flex h-9 w-full items-center gap-2.5 rounded-md px-2 font-semibold text-primary hover:bg-hairline">
            <span className="grid size-6 place-items-center rounded-full bg-primary text-white">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d="M12 6v12M6 12h12" /></svg>
            </span>
            Add task
          </button>
          <SideItem icon={Icon.search} label="Search" active={tab === "search"} onClick={() => setTab("search")} />
          <SideItem icon={Icon.inbox} label="Inbox" count={open.filter((t) => t.status === "inbox" && !t.free_time).length} active={tab === "inbox"} onClick={() => setTab("inbox")} />
          <SideItem icon={<span aria-hidden>🌙</span>} label="Free Time" count={open.filter((t) => t.free_time).length} active={tab === "freetime"} onClick={() => setTab("freetime")} />
          <SideItem icon={Icon.today} label="Today" count={todayCount} active={tab === "today"} onClick={() => setTab("today")} />
          <SideItem icon={Icon.upcoming} label="Upcoming" active={tab === "upcoming"} onClick={() => setTab("upcoming")} />
          <SideItem icon={<span aria-hidden>🗂</span>} label="Plan" active={tab === "board"} onClick={() => setTab("board")} />
          <SideItem icon={<span aria-hidden>🔥</span>} label="Habits" count={(state.habits ?? []).filter((h) => h.dueToday && !h.doneToday).length} active={tab === "habits"} onClick={() => setTab("habits")} />
          <SideItem icon={Icon.filter} label="Filters & Labels" active={tab === "filters"} onClick={() => setTab("filters")} />
          <SideItem icon={Icon.chat} label="Chat with Tony" active={tab === "chat"} onClick={() => setTab("chat")} />
          <p className="mt-5 mb-1 px-2 text-[13px] font-semibold text-secondary">My Projects</p>
          {state.projects.map((project) => (
            <SideItem
              key={project.id}
              icon={<span style={{ color: project.color }}>{Icon.hash}</span>}
              label={project.name}
              count={open.filter((t) => t.project_id === project.id).length}
              active={tab === `project:${project.id}`}
              onClick={() => setTab(`project:${project.id}`)}
            />
          ))}
        </nav>
        <div className="safe-bottom border-t border-hairline px-2 py-2 text-[14px]">
          <SideItem icon={Icon.plan} label="Tony's plans" onClick={() => setMenu(true)} />
          <SideItem icon={Icon.settings} label="Settings" onClick={() => setMenu(true)} />
        </div>
      </aside>

      <div className="safe-top flex min-w-0 flex-1 flex-col">
      {/* Phones: the avatar opens projects and settings. */}
      <div className="flex h-12 shrink-0 items-center px-3 md:hidden">
        <button type="button" aria-label="Projects and settings" onClick={() => setMenu(true)} className="grid size-11 place-items-center">
          <Image src="/brand/avatar.png" alt="" width={36} height={36} priority className="size-9 rounded-full shadow-md shadow-accent/25" />
        </button>
        <span className="flex-1" />
        <button type="button" aria-label="Search" onClick={() => setTab("search")} className="grid size-11 place-items-center text-secondary">
          {Icon.search}
        </button>
      </div>

      {tab === "today" && <TodayScreen {...screen} onQuickAdd={tell} onReschedule={reschedule} />}
      {tab === "inbox" && <InboxScreen {...screen} onFreeTime={() => setTab("freetime")} />}
      {tab === "freetime" && <FreeTimeScreen {...screen} />}
      {tab === "upcoming" && <UpcomingScreen {...screen} onMove={move} onAddTo={(day) => setSheet({ day })} />}
      {tab === "search" && <SearchScreen {...screen} />}
      {tab === "filters" && <FiltersScreen {...screen} onProject={(id) => setTab(`project:${id}`)} />}
      {tab === "habits" && <HabitsScreen state={state} onCheck={checkHabit} />}
      {tab === "board" && <BoardScreen {...screen} onLane={lane} />}
      {projectId !== undefined && <ProjectScreen {...screen} projectId={projectId} />}
      {tab === "chat" && <ChatScreen state={state} onSend={tell} onVoice={voice} />}

      <nav aria-label="Main" className="safe-bottom shrink-0 border-t border-hairline bg-background md:hidden">
        <div className="relative grid h-14 grid-cols-5">
          {TABS.slice(0, 2).map((item) => (
            <TabButton key={item.id} item={item} active={tab === item.id} onSelect={setTab} />
          ))}
          <div className="grid place-items-center">
            <button
              type="button"
              aria-label="New task"
              onClick={() => {
                haptic("tap");
                setSheet({});
              }}
              className="grid size-14 -translate-y-3 place-items-center rounded-full text-white shadow-lg shadow-accent/35 transition-transform active:scale-95"
              style={{ background: "var(--tony-gradient)" }}
            >
              {Icon.plus}
            </button>
          </div>
          {TABS.slice(2).map((item) => (
            <TabButton key={item.id} item={item} active={tab === item.id} onSelect={setTab} />
          ))}
        </div>
      </nav>

      </div>

      {rowMenu && (
        <RowMenu
          task={rowMenu}
          onClose={() => setRowMenu(null)}
          onEdit={() => (setRowMenu(null), setSheet({ task: rowMenu }))}
          onComment={() => (setRowMenu(null), setSheet({ task: rowMenu, focus: "notes" }))}
          onAddPart={() => (setRowMenu(null), setAddingPart(rowMenu.id))}
          onDate={(choice) => (setRowMenu(null), redate(rowMenu, choice))}
          onPriority={(p) => (setRowMenu(null), actions.priority(rowMenu, p))}
          onDelete={() => (setRowMenu(null), actions.remove(rowMenu))}
        />
      )}

      {menu && (
        <Menu
          tony={tony}
          now={now}
          theme={theme}
          onTheme={changeTheme}
          onClose={() => setMenu(false)}
          onOpen={(task) => setSheet({ task })}
          onToggle={toggle}
          onGo={(next) => (setMenu(false), setTab(next))}
        />
      )}

      {sheet && (
        <TaskSheet
          key={sheet.task?.id ?? `new-${sheet.day ?? ""}-${sheet.projectId ?? ""}`}
          target={sheet}
          projects={state.projects}
          media={sheet.task ? state.media.filter((item) => item.task_id === sheet.task!.id) : []}
          onClose={() => setSheet(null)}
          onSave={async (action, payload) => {
            const ok = (await act(action, payload)).ok;
            if (ok) haptic("success");
            return ok;
          }}
          onDelete={(task) => {
            setSheet(null);
            void act("update_task", { id: task.id, status: "dropped" }, (s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== task.id) }));
          }}
        />
      )}

      {toast && (
        <div role="status" className="fade-in pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+12px)]">
          <p className={`max-w-sm rounded-2xl px-4 py-3 text-sub shadow-xl ${toast.tone === "error" ? "bg-overdue text-white" : "bg-ink text-background"}`}>{toast.text}</p>
        </div>
      )}
    </div>
    </RowActionsContext.Provider>
  );
}

function SideItem({ icon, label, count, active, onClick }: { icon: React.ReactNode; label: string; count?: number; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors ${active ? "bg-primary/12 font-medium text-primary" : "hover:bg-hairline"}`}
    >
      <span className={`grid size-6 place-items-center [&_svg]:size-[18px] ${active ? "" : "text-secondary"}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && <span className="text-[12px] text-secondary">{count}</span>}
    </button>
  );
}

/** Long-press on a phone (and "More" on a wide screen): what can be done to one task. */
function RowMenu(props: {
  task: Task;
  onClose: () => void;
  onEdit: () => void;
  onComment: () => void;
  onAddPart: () => void;
  onDate: (choice: "today" | "tomorrow" | "next-week" | "none") => void;
  onPriority: (priority: number) => void;
  onDelete: () => void;
}) {
  const { task, onClose, onEdit, onComment, onAddPart, onDate, onPriority, onDelete } = props;
  const item = "flex h-11 w-full items-center gap-3 px-4 text-left text-[15px] hover:bg-surface";
  return (
    <div className="fade-in fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center" onClick={onClose}>
      <div role="dialog" aria-label={task.title} onClick={(event) => event.stopPropagation()} className="sheet-up safe-bottom w-full max-w-md overflow-hidden rounded-t-sheet bg-background pb-2 shadow-2xl md:rounded-xl">
        <p className="truncate border-b border-hairline px-4 py-3 text-[14px] font-semibold">{task.title}</p>
        <button type="button" className={item} onClick={onEdit}>
          <span className="text-secondary">{Icon.pencil}</span>Edit
        </button>
        <button type="button" className={item} onClick={onComment}>
          <span className="text-secondary">{Icon.comment}</span>Comment
        </button>
        <button type="button" className={item} onClick={onAddPart}>
          <span className="w-[18px] text-center text-secondary">+</span>Add subtask
        </button>
        <div className="border-t border-hairline px-4 pt-3 pb-1 text-[12px] font-semibold text-secondary">Date</div>
        <div className="grid grid-cols-4 gap-1 px-3 pb-2">
          {([["Today", "today", "var(--today)"], ["Tomorrow", "tomorrow", "var(--tomorrow)"], ["Next week", "next-week", "var(--week)"], ["No date", "none", "var(--secondary)"]] as const).map(([label, choice, color]) => (
            <button key={choice} type="button" onClick={() => onDate(choice)} className="flex flex-col items-center gap-1 rounded-lg py-2 text-[12px] hover:bg-surface">
              <span style={{ color }} className="[&_svg]:size-5">{Icon.calendar}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="border-t border-hairline px-4 pt-3 pb-1 text-[12px] font-semibold text-secondary">Priority</div>
        <div className="grid grid-cols-3 gap-1 px-3 pb-2">
          {[1, 2, 4].map((p) => (
            <button key={p} type="button" onClick={() => onPriority(p)} aria-pressed={task.priority === p} className={`flex h-10 items-center justify-center gap-1.5 rounded-lg text-[13px] ${task.priority === p ? "bg-surface font-semibold" : "hover:bg-surface"}`}>
              <span className="size-3 rounded-full" style={{ background: `var(--p${p})` }} />{p === 1 ? "Urgent" : p === 2 ? "Important" : "Normal"}
            </button>
          ))}
        </div>
        <button type="button" className={`${item} border-t border-hairline text-overdue`} onClick={onDelete}>
          Delete task
        </button>
      </div>
    </div>
  );
}

function TabButton({ item, active, onSelect }: { item: (typeof TABS)[number]; active: boolean; onSelect: (tab: Tab) => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        haptic("select");
        onSelect(item.id);
      }}
      className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${active ? "text-primary" : "text-secondary"}`}
    >
      {item.icon}
      {item.label}
    </button>
  );
}
