"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LayoutGrid, ChevronDown, ChevronRight, ExternalLink, Loader2, Search, SkipForward, Undo2,
} from "lucide-react";
import { LIFECYCLE_META, type LifecycleStatus } from "@/lib/client-lifecycle";

export interface ManagerRow {
  id: string;
  client_name: string;
  jurisdiction: string | null;
  state_province: string | null;
  assigned_bookkeeper_id: string | null;
  assigned_bookkeeper_name: string | null;
  status: LifecycleStatus;
  bs_cleanup_skipped: boolean;
  /** true while the client is still in cleanup (BS skip is only meaningful here) */
  in_cleanup_phase: boolean;
}
interface Bk { id: string; full_name: string }

const STATUS_ORDER = (Object.keys(LIFECYCLE_META) as LifecycleStatus[]).sort(
  (a, b) => LIFECYCLE_META[a].order - LIFECYCLE_META[b].order
);

/**
 * Manager dashboard — the Double-style "every client, preparer, status" view
 * Lisa asked for. One flat table across all lifecycle stages, with inline
 * preparer reassignment and a BS-cleanup bypass. Collapsible; sits above the
 * existing kanban/list on /clients.
 */
export function ManagerDashboard({
  rows: initialRows,
  bookkeepers,
  canEdit,
}: {
  rows: ManagerRow[];
  bookkeepers: Bk[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState(initialRows);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<LifecycleStatus | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let r = rows;
    if (statusFilter !== "all") r = r.filter((x) => x.status === statusFilter);
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter(
        (x) => x.client_name.toLowerCase().includes(s) || (x.assigned_bookkeeper_name || "").toLowerCase().includes(s)
      );
    }
    return [...r].sort(
      (a, b) => LIFECYCLE_META[a.status].order - LIFECYCLE_META[b.status].order || a.client_name.localeCompare(b.client_name)
    );
  }, [rows, q, statusFilter]);

  const counts = useMemo(() => {
    const m = new Map<LifecycleStatus, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) || 0) + 1);
    return m;
  }, [rows]);

  async function reassign(id: string, bkId: string) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_bookkeeper_id: bkId || null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setRows((prev) => prev.map((r) => r.id === id
        ? { ...r, assigned_bookkeeper_id: bkId || null, assigned_bookkeeper_name: bookkeepers.find((b) => b.id === bkId)?.full_name || null }
        : r));
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  async function toggleSkipBs(id: string, skip: boolean) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/clients/${id}/skip-bs-cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skip }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setRows((prev) => prev.map((r) => r.id === id ? { ...r, bs_cleanup_skipped: skip } : r));
      router.refresh();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  return (
    <section className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-5 py-3 border-b border-gray-100 hover:bg-gray-50"
      >
        {open ? <ChevronDown size={16} className="text-ink-slate" /> : <ChevronRight size={16} className="text-ink-slate" />}
        <LayoutGrid size={16} className="text-teal" />
        <h2 className="text-sm font-bold text-navy">Manager dashboard</h2>
        <span className="text-[11px] text-ink-light">every client · preparer · status</span>
        <span className="ml-auto text-xs font-bold text-ink-slate bg-slate-100 rounded-full px-2 py-0.5">{rows.length}</span>
      </button>

      {open && (
        <div className="p-4">
          {/* Filters */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-light" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or preparer…"
                className="text-sm rounded-lg border border-gray-200 pl-7 pr-3 py-1.5 w-56 focus:outline-none focus:border-teal"
              />
            </div>
            <button
              onClick={() => setStatusFilter("all")}
              className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statusFilter === "all" ? "bg-navy text-white" : "bg-slate-100 text-ink-slate hover:bg-slate-200"}`}
            >
              All {rows.length}
            </button>
            {STATUS_ORDER.filter((s) => counts.get(s)).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statusFilter === s ? "bg-navy text-white" : LIFECYCLE_META[s].tone + " hover:opacity-80"}`}
              >
                {LIFECYCLE_META[s].label} {counts.get(s)}
              </button>
            ))}
          </div>

          {error && <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-ink-light text-left border-b border-gray-100">
                  <th className="py-2 pr-3 font-bold">Client</th>
                  <th className="py-2 pr-3 font-bold">Preparer</th>
                  <th className="py-2 pr-3 font-bold">Status</th>
                  <th className="py-2 pr-3 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-teal-lighter/40">
                    <td className="py-2.5 pr-3">
                      <Link href={`/clients/${r.id}`} className="font-semibold text-navy hover:underline inline-flex items-center gap-1 group">
                        {r.client_name}
                        <ExternalLink size={11} className="opacity-0 group-hover:opacity-50" />
                      </Link>
                      {(r.jurisdiction || r.state_province) && (
                        <span className="text-[11px] text-ink-light ml-2">{r.state_province || r.jurisdiction}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {canEdit ? (
                        <select
                          value={r.assigned_bookkeeper_id || ""}
                          onChange={(e) => reassign(r.id, e.target.value)}
                          disabled={busy === r.id}
                          className="text-xs rounded-md border border-gray-200 px-1.5 py-1 bg-white text-navy max-w-[160px]"
                        >
                          <option value="">Unassigned</option>
                          {bookkeepers.map((b) => <option key={b.id} value={b.id}>{b.full_name}</option>)}
                        </select>
                      ) : (
                        <span className="text-ink-slate">{r.assigned_bookkeeper_name || "—"}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full ${LIFECYCLE_META[r.status].tone}`}>
                        {LIFECYCLE_META[r.status].label}
                      </span>
                      {r.bs_cleanup_skipped && (
                        <span className="ml-1.5 text-[10px] text-ink-light italic">BS skipped</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-1 text-right whitespace-nowrap">
                      {busy === r.id && <Loader2 size={13} className="animate-spin text-teal inline mr-2" />}
                      {canEdit && r.in_cleanup_phase && (
                        r.bs_cleanup_skipped ? (
                          <button
                            onClick={() => toggleSkipBs(r.id, false)}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-gray-200 text-ink-slate hover:bg-gray-50"
                            title="Undo: this client owes a BS cleanup again"
                          >
                            <Undo2 size={11} /> Un-skip BS
                          </button>
                        ) : (
                          <button
                            onClick={() => toggleSkipBs(r.id, true)}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50"
                            title="Skip the balance-sheet cleanup for this client"
                          >
                            <SkipForward size={11} /> Skip BS
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="py-8 text-center text-ink-light text-sm italic">No clients match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
