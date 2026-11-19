"use client";

import Image from "next/image";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AppState } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { formatTime } from "@/lib/time";
import { Menu, type Theme } from "./menu";
import { ChatScreen, InboxScreen, TodayScreen, UpcomingScreen } from "./screens";
import { TaskSheet, type SheetTarget } from "./task-sheet";
import { Icon, isOpen } from "./ui";
import { applyTelegramTheme, haptic, pushBack, tonyFetch, webApp } from "./telegram";
import { useTony } from "./use-tony";

type Tab = "today" | "inbox" | "upcoming" | "chat";

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

  const screen = { state, now, onOpen: (task: Task) => setSheet({ task }), onToggle: toggle };

  return (
    <div className="safe-top mx-auto flex h-dvh max-w-md flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center px-3">
        <button type="button" aria-label="Projects and settings" onClick={() => setMenu(true)} className="grid size-11 place-items-center">
          <Image src="/brand/avatar.png" alt="" width={36} height={36} priority className="size-9 rounded-full shadow-md shadow-accent/25" />
        </button>
      </div>

      {tab === "today" && <TodayScreen {...screen} onQuickAdd={tell} />}
      {tab === "inbox" && <InboxScreen {...screen} />}
      {tab === "upcoming" && <UpcomingScreen {...screen} onMove={move} onAddTo={(day) => setSheet({ day })} />}
      {tab === "chat" && <ChatScreen state={state} onSend={tell} onVoice={voice} />}

      <nav aria-label="Main" className="safe-bottom shrink-0 border-t border-hairline bg-background">
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

      {menu && (
        <Menu
          tony={tony}
          now={now}
          theme={theme}
          onTheme={changeTheme}
          onClose={() => setMenu(false)}
          onOpen={(task) => setSheet({ task })}
          onToggle={toggle}
        />
      )}

      {sheet && (
        <TaskSheet
          key={sheet.task?.id ?? `new-${sheet.day ?? ""}`}
          target={sheet}
          projects={state.projects}
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
