/**
 * tasks — the hand-off board (2026-09-19, Brady's ask).
 *
 * The problem it solves: a piece of work is paused for another, and when it is
 * picked up again neither side remembers exactly where it was. So every task
 * carries a RESUME BRIEF — the paragraph needed to pick it up cold: goal, where
 * it is right now, the exact next action, how we'll know it is done, and what
 * is blocked on Brady — rewritten every time work on it stops. Plus a dated
 * log of what happened, links to the evidence (hands, sessions, files, notes),
 * a status and Brady's priority order.
 *
 * Lives in data/tasks.json (like ledger.json: the file is the source of
 * truth; the API is the only writer). Served on /tasks in the dashboard.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tasksPath } from "./storePaths";

export type TaskStatus = "idea" | "ready" | "active" | "waiting" | "done";
export const STATUSES: TaskStatus[] = ["idea", "ready", "active", "waiting", "done"];

export interface TaskLink { label: string; href: string }
export interface TaskLog { at: number; note: string }
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  order: number;
  goal: string;
  /** Where it is right now — the paragraph that lets either of us resume cold. */
  brief: string;
  /** The exact next action. */
  next: string;
  doneWhen: string;
  /** What only Brady can do for it, or null. */
  needsYou: string | null;
  links: TaskLink[];
  log: TaskLog[];
  createdAt: number;
  updatedAt: number;
}

const PATH = tasksPath();

export function loadTasks(): Task[] {
  if (!existsSync(PATH)) return [];
  try {
    const j = JSON.parse(readFileSync(PATH, "utf-8")) as { tasks?: Task[] };
    return (j.tasks ?? []).sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

function save(tasks: Task[]): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify({ tasks: tasks.sort((a, b) => a.order - b.order) }, null, 2));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "task";

export function createTask(input: Partial<Task> & { title: string }): Task {
  const tasks = loadTasks();
  let id = input.id ?? slug(input.title);
  while (tasks.some((t) => t.id === id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
  const now = Date.now();
  const t: Task = {
    id, title: input.title, status: STATUSES.includes(input.status as TaskStatus) ? (input.status as TaskStatus) : "idea",
    order: input.order ?? (tasks.length ? Math.max(...tasks.map((x) => x.order)) + 1 : 1),
    goal: input.goal ?? "", brief: input.brief ?? "", next: input.next ?? "", doneWhen: input.doneWhen ?? "",
    needsYou: input.needsYou ?? null, links: input.links ?? [],
    log: (input.log ?? []).length ? input.log! : [{ at: now, note: "created" }],
    createdAt: now, updatedAt: now,
  };
  tasks.push(t);
  save(tasks);
  return t;
}

/** Update fields; `note` appends a dated log line. Changing the brief without a note logs "brief updated". */
export function updateTask(id: string, patch: Partial<Task> & { note?: string }): Task | null {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  const now = Date.now();
  for (const k of ["title", "goal", "brief", "next", "doneWhen", "needsYou", "links"] as const) {
    if (patch[k] !== undefined) (t as any)[k] = patch[k];
  }
  if (patch.status !== undefined && STATUSES.includes(patch.status)) t.status = patch.status;
  if (typeof patch.order === "number") t.order = patch.order;
  if (patch.note) t.log.push({ at: now, note: patch.note });
  else if (patch.brief !== undefined || patch.next !== undefined) t.log.push({ at: now, note: "brief updated" });
  t.updatedAt = now;
  save(tasks);
  return t;
}

export function reorderTasks(ids: string[]): Task[] {
  const tasks = loadTasks();
  ids.forEach((id, i) => { const t = tasks.find((x) => x.id === id); if (t) t.order = i + 1; });
  let n = ids.length;
  for (const t of tasks) if (!ids.includes(t.id)) t.order = ++n;
  save(tasks);
  return loadTasks();
}
