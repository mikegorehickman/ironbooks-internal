"use client";

import { useMemo, useState } from "react";
import { Plus, Loader2, Trash2, CalendarClock, User, Building2 } from "lucide-react";

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  assignee_name: string | null;
  client_link_id: string | null;
  client_name: string | null;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
}
export interface StaffOption { id: string; name: string }
export interface ClientOption { id: string; name: string }

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];
const PRIORITY_DOT: Record<TaskPriority, string> = {
  high: "bg-red-500",
  normal: "bg-slate-300",
  low: "bg-slate-200",
};

function fmtDue(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = due < today;
  return { text: due.toLocaleDateString("en-US", { month: "short", day: "numeric" }), overdue };
}

export function TasksBoard({
  initialTasks, staff, clients, currentUserId,
}: {
  initialTasks: Task[];
  staff: StaffOption[];
  clients: ClientOption[];
  currentUserId: string;
}) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [mineOnly, setMineOnly] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // New-task form
  const [title, setTitle] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [newClient, setNewClient] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newPriority, setNewPriority] = useState<TaskPriority>("normal");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s.name])), [staff]);
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);

  function enrich(row: any): Task {
    return {
      ...row,
      assignee_name: row.assignee_id ? staffById.get(row.assignee_id) || "—" : null,
      client_name: row.client_link_id ? clientById.get(row.client_link_id) || "—" : null,
    };
  }

  async function addTask() {
    if (!title.trim()) return;
    setAdding(true); setErr(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title, assignee_id: newAssignee || null, client_link_id: newClient || null,
          due_date: newDue || null, priority: newPriority,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Couldn't add task");
      setTasks((t) => [enrich(d.task), ...t]);
      setTitle(""); setNewClient(""); setNewDue(""); setNewPriority("normal");
    } catch (e: any) { setErr(e.message); } finally { setAdding(false); }
  }

  async function patch(id: string, body: Record<string, any>) {
    setBusyId(id); setErr(null);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Update failed");
      setTasks((t) => t.map((x) => (x.id === id ? enrich(d.task) : x)));
    } catch (e: any) { setErr(e.message); } finally { setBusyId(null); }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this task?")) return;
    setBusyId(id); setErr(null);
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setTasks((t) => t.filter((x) => x.id !== id));
    } catch (e: any) { setErr(e.message); setBusyId(null); }
  }

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return tasks.filter((t) =>
      (!mineOnly || t.assignee_id === currentUserId) &&
      (assigneeFilter === "all" || t.assignee_id === assigneeFilter) &&
      (!s || t.title.toLowerCase().includes(s) || (t.notes || "").toLowerCase().includes(s) || (t.client_name || "").toLowerCase().includes(s))
    );
  }, [tasks, mineOnly, assigneeFilter, q, currentUserId]);

  const openMine = tasks.filter((t) => t.assignee_id === currentUserId && t.status !== "done").length;

  return (
    <div className="space-y-4 max-w-6xl">
      {/* New task */}
      <div className="bg-white border border-gray-100 rounded-2xl p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="text-[10px] font-bold uppercase tracking-wider text-ink-light">New task</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addTask(); }}
              placeholder="What needs doing?"
              className="w-full mt-0.5 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
          <select value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)} className="rounded-lg border border-gray-200 px-2 py-2 text-sm">
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={newClient} onChange={(e) => setNewClient(e.target.value)} className="rounded-lg border border-gray-200 px-2 py-2 text-sm max-w-[160px]">
            <option value="">No client</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} className="rounded-lg border border-gray-200 px-2 py-2 text-sm" />
          <select value={newPriority} onChange={(e) => setNewPriority(e.target.value as TaskPriority)} className="rounded-lg border border-gray-200 px-2 py-2 text-sm">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
          <button onClick={addTask} disabled={adding || !title.trim()} className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <button onClick={() => setMineOnly((v) => !v)} className={`font-semibold px-2.5 py-1 rounded-full border ${mineOnly ? "border-teal bg-teal-lighter text-teal-dark" : "border-gray-200 text-ink-slate hover:border-gray-300"}`}>
          My tasks{openMine > 0 && <span className="ml-1 text-[10px]">({openMine})</span>}
        </button>
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="rounded-md border border-gray-200 px-2 py-1">
          <option value="all">Everyone</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks…" className="rounded-md border border-gray-200 px-2.5 py-1 min-w-[160px]" />
        {err && <span className="text-red-600 font-medium">{err}</span>}
      </div>

      {/* Board */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {COLUMNS.map((col) => {
          const colTasks = visible.filter((t) => t.status === col.key);
          return (
            <div key={col.key} className="bg-slate-50 border border-gray-100 rounded-2xl p-3">
              <div className="flex items-center justify-between mb-2 px-1">
                <h3 className="text-sm font-bold text-navy">{col.label}</h3>
                <span className="text-[11px] font-semibold text-ink-light bg-white rounded-full px-2 py-0.5">{colTasks.length}</span>
              </div>
              <div className="space-y-2">
                {colTasks.map((t) => {
                  const due = fmtDue(t.due_date);
                  return (
                    <div key={t.id} className={`bg-white border rounded-xl p-3 ${busyId === t.id ? "opacity-60" : ""} ${t.status === "done" ? "border-gray-100" : "border-gray-200"}`}>
                      <div className="flex items-start gap-2">
                        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[t.priority]}`} title={`${t.priority} priority`} />
                        <div className="min-w-0 flex-1">
                          <div className={`text-sm font-medium text-navy ${t.status === "done" ? "line-through text-ink-light" : ""}`}>{t.title}</div>
                          {t.notes && <div className="text-[11px] text-ink-slate mt-0.5 line-clamp-2">{t.notes}</div>}
                          <div className="flex items-center gap-2 flex-wrap mt-2 text-[10px]">
                            {t.client_name && (
                              <span className="inline-flex items-center gap-1 text-ink-slate bg-slate-100 rounded px-1.5 py-0.5"><Building2 size={10} />{t.client_name}</span>
                            )}
                            {due && (
                              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${due.overdue && t.status !== "done" ? "bg-red-50 text-red-700 font-semibold" : "text-ink-light bg-slate-100"}`}>
                                <CalendarClock size={10} />{due.text}{due.overdue && t.status !== "done" ? " · overdue" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        <button onClick={() => remove(t.id)} disabled={busyId === t.id} className="text-ink-light hover:text-red-600 flex-shrink-0" title="Delete">
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 mt-2.5">
                        <User size={11} className="text-ink-light flex-shrink-0" />
                        <select
                          value={t.assignee_id || ""}
                          onChange={(e) => patch(t.id, { assignee_id: e.target.value || null })}
                          className="text-[11px] rounded border border-gray-200 px-1 py-0.5 flex-1 min-w-0"
                        >
                          <option value="">Unassigned</option>
                          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <select
                          value={t.status}
                          onChange={(e) => patch(t.id, { status: e.target.value })}
                          className="text-[11px] rounded border border-gray-200 px-1 py-0.5 font-semibold text-teal-dark"
                        >
                          {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                        </select>
                      </div>
                    </div>
                  );
                })}
                {colTasks.length === 0 && <div className="text-[11px] text-ink-light italic px-1 py-3 text-center">Nothing here.</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
