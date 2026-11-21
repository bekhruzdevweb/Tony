"use client";

import { useState } from "react";
import type { AppMedia, AppProject } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { formatTime, localDate } from "@/lib/time";
import { Icon, isOpen } from "./ui";

export type SheetTarget = { task?: Task; day?: string; projectId?: number; focus?: "notes" };

const field = "w-full rounded-card bg-surface px-3.5 py-3 text-body outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40";
const label = "mb-1.5 block px-1 text-caption font-medium text-secondary";

/** The bottom sheet for adding or editing one task. */
export function TaskSheet(props: {
  target: SheetTarget;
  projects: AppProject[];
  /** Photos and files attached to this task. */
  media?: AppMedia[];
  onClose: () => void;
  onSave: (action: "add_task" | "update_task", payload: Record<string, unknown>) => Promise<boolean>;
  onDelete: (task: Task) => void;
}) {
  const { target, projects, media = [], onClose, onSave, onDelete } = props;
  const task = target.task;
  const due = task?.due_at ? new Date(task.due_at) : undefined;

  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [date, setDate] = useState(due ? localDate(due) : (target.day ?? ""));
  const [time, setTime] = useState(due ? formatTime(due) : "");
  const [priority, setPriority] = useState(task?.priority ?? 4);
  const [project, setProject] = useState(projects.find((p) => p.id === (task?.project_id ?? target.projectId))?.name ?? "none");
  const [duration, setDuration] = useState(task?.duration_minutes ? String(task.duration_minutes) : "");
  const [repeat, setRepeat] = useState<string>(task?.repeat_rule ?? "none");
  const [persistent, setPersistent] = useState(task?.persistent ?? false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    const payload: Record<string, unknown> = { title: title.trim(), notes, priority, project, repeat, persistent, duration: duration ? Number(duration) : task?.duration_minutes ? 0 : undefined };
    // Times are Tashkent time. A date with no time means 09:00 that day.
    const dueText = date ? `${date}T${time || "09:00"}` : "";
    const before = due ? `${localDate(due)}T${formatTime(due)}` : "";
    if (dueText && dueText !== before) payload.due_at = dueText;
    if (!dueText && task?.due_at) payload.clear_due = true;
    if (task) payload.id = task.id;
    const ok = await onSave(task ? "update_task" : "add_task", payload);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <div className="fade-in fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center md:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={task ? "Edit task" : "New task"}
        onClick={(event) => event.stopPropagation()}
        className="sheet-up safe-bottom max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-sheet bg-background shadow-2xl md:max-w-xl md:rounded-xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between bg-background/95 px-4 pt-3 pb-2 backdrop-blur">
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 place-items-center rounded-full text-secondary">
            {Icon.close}
          </button>
          <span className="text-sub font-semibold">{task ? "Task" : "New task"}</span>
          <button
            type="button"
            onClick={save}
            disabled={!title.trim() || saving}
            className="h-11 rounded-full px-4 text-body font-semibold text-primary disabled:opacity-40"
          >
            {saving ? "Saving" : "Save"}
          </button>
        </div>

        <div className="space-y-5 px-4 pt-1 pb-6">
          <div className="space-y-2">
            <input
              className={`${field} text-section font-semibold`}
              placeholder="What needs doing?"
              value={title}
              autoFocus={!task}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && save()}
            />
            <textarea className={field} rows={2} placeholder="Description" autoFocus={target.focus === "notes"} value={notes ?? ""} onChange={(event) => setNotes(event.target.value)} />
          </div>

          {media.length > 0 && (
            <div>
              <span className={label}>Attached</span>
              <ul className="space-y-2">
                {media.map((item) => (
                  <li key={item.id} className="overflow-hidden rounded-card bg-surface">
                    {item.url && (item.kind === "photo" || item.kind === "animation") && (
                      // A temporary signed link to a private file: not something the image optimiser can fetch.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.url} alt={item.note ?? item.caption ?? "Attached photo"} className="max-h-72 w-full object-contain" loading="lazy" />
                    )}
                    {item.url && (item.kind === "video" || item.kind === "video_note") && <video src={item.url} controls preload="metadata" className="max-h-72 w-full" />}
                    {item.url && (item.kind === "voice" || item.kind === "audio") && <audio src={item.url} controls className="w-full" />}
                    <p className="px-3.5 py-2.5 text-sub">
                      <span className="font-medium capitalize">{item.kind}</span>
                      {(item.note || item.caption) && <span className="text-secondary"> · {item.note ?? item.caption}</span>}
                      {!item.url && <span className="block text-caption text-secondary">Kept in Telegram; Tony sends it with the reminder.</span>}
                      {item.url && item.kind === "document" && (
                        <a href={item.url} target="_blank" rel="noreferrer" className="block text-primary">
                          Open file
                        </a>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <span className={label}>Date and time (Tashkent)</span>
            <div className="flex gap-2">
              <input type="date" aria-label="Date" className={`${field} min-w-0 basis-3/5 appearance-none`} value={date} onChange={(event) => setDate(event.target.value)} />
              <input type="time" aria-label="Time" className={`${field} min-w-0 basis-2/5 appearance-none`} value={time} onChange={(event) => setTime(event.target.value)} />
            </div>
            {date && (
              <button type="button" className="mt-1.5 h-9 px-1 text-sub text-secondary" onClick={() => (setDate(""), setTime(""))}>
                Remove date (move to Inbox)
              </button>
            )}
          </div>

          <div>
            <span className={label}>Priority</span>
            <div className="grid grid-cols-4 gap-1 rounded-card bg-surface p-1">
              {[1, 2, 3, 4].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  aria-pressed={priority === p}
                  className={`h-10 rounded-[9px] text-sub font-medium transition-colors ${priority === p ? "bg-background shadow-sm" : "text-secondary"}`}
                >
                  P{p}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className={label}>Duration (minutes)</span>
            <input type="number" inputMode="numeric" min={1} max={1440} placeholder="How long it takes" className={field} value={duration} onChange={(event) => setDuration(event.target.value.replace(/\D/g, ""))} />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label>
              <span className={label}>Project</span>
              <select className={field} value={project} onChange={(event) => setProject(event.target.value)}>
                <option value="none">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={label}>Repeat</span>
              <select className={field} value={repeat} onChange={(event) => setRepeat(event.target.value)}>
                <option value="none">Never</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
          </div>

          <label className="flex min-h-11 items-center justify-between gap-4 rounded-card bg-surface px-3.5 py-3">
            <span>
              <span className="block text-body">Persistent</span>
              <span className="block text-caption text-secondary">Tony keeps nudging until you tap Start or Skip</span>
            </span>
            <input type="checkbox" className="peer sr-only" checked={persistent} onChange={(event) => setPersistent(event.target.checked)} />
            <span className="relative h-8 w-13 shrink-0 rounded-full bg-secondary/30 transition-colors peer-checked:bg-done peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:absolute after:top-0.5 after:left-0.5 after:size-7 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
          </label>

          {task && isOpen(task) && (
            <button type="button" onClick={() => onDelete(task)} className="h-11 w-full rounded-card text-body font-medium text-overdue">
              Delete task
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
