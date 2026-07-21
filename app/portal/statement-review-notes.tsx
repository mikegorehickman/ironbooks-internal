"use client";

import { useEffect, useState } from "react";
import { StickyNote, Loader2, Check, X, Plus, RotateCcw } from "lucide-react";

/**
 * Internal reviewer notes on a client statement. Rendered ONLY when a staff
 * member is impersonating (reviewing what the client sees) — the real client
 * never sees this. A floating panel, bottom-right, so it doesn't alter the
 * statement layout. Notes are pinned to {clientLinkId, kind, period}.
 */
interface Note {
  id: string;
  body: string;
  anchor: string | null;
  resolved_at: string | null;
  created_by_name: string | null;
  created_at: string;
}

export function StatementReviewNotes({
  clientLinkId,
  kind,
  period,
  statementLabel,
}: {
  clientLinkId: string;
  kind: "pl" | "bs" | "cash_flow" | "package";
  period?: string;
  statementLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const qs = new URLSearchParams({ kind, ...(period ? { period } : {}) }).toString();

  async function load() {
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/statement-notes?${qs}`);
      const j = await res.json();
      setNotes(j.notes || []);
    } catch {
      /* ignore */
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId, kind, period]);

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/statement-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statement_kind: kind, period: period || undefined, body }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Couldn't save");
      setNotes((n) => [j.note, ...n]);
      setDraft("");
    } catch (e: any) {
      setErr(e?.message || "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function toggleResolved(note: Note) {
    const resolved = !note.resolved_at;
    setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, resolved_at: resolved ? new Date().toISOString() : null } : n)));
    await fetch(`/api/clients/${clientLinkId}/statement-notes`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId: note.id, resolved }),
    }).catch(() => {});
  }

  async function remove(note: Note) {
    setNotes((ns) => ns.filter((n) => n.id !== note.id));
    await fetch(`/api/clients/${clientLinkId}/statement-notes?noteId=${note.id}`, { method: "DELETE" }).catch(() => {});
  }

  const openCount = notes.filter((n) => !n.resolved_at).length;

  return (
    <div className="fixed bottom-4 right-4 z-[80] print:hidden">
      {open ? (
        <div className="w-80 max-h-[70vh] flex flex-col rounded-xl border border-amber-300 bg-white shadow-2xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-amber-200 bg-amber-50 rounded-t-xl">
            <span className="text-sm font-bold text-amber-800 flex items-center gap-1.5">
              <StickyNote size={14} /> Reviewer notes
            </span>
            <button onClick={() => setOpen(false)} className="text-amber-700 hover:text-amber-900">
              <X size={16} />
            </button>
          </div>
          <div className="px-3 py-2 text-[11px] text-ink-slate border-b border-gray-100">
            Internal only — not shown to {statementLabel ? "the client on this " + statementLabel : "the client"}.
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {!loaded ? (
              <div className="text-xs text-ink-light flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Loading…</div>
            ) : notes.length === 0 ? (
              <div className="text-xs text-ink-light italic">No notes yet.</div>
            ) : (
              notes.map((n) => (
                <div
                  key={n.id}
                  className={`rounded-lg border px-2.5 py-2 text-xs ${n.resolved_at ? "border-gray-200 bg-gray-50 opacity-70" : "border-amber-200 bg-amber-50/50"}`}
                >
                  <p className={`text-navy ${n.resolved_at ? "line-through" : ""}`}>{n.body}</p>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[10px] text-ink-light">
                      {n.created_by_name || "—"} · {new Date(n.created_at).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => toggleResolved(n)} className="text-ink-slate hover:text-navy" title={n.resolved_at ? "Reopen" : "Resolve"}>
                        {n.resolved_at ? <RotateCcw size={12} /> : <Check size={12} />}
                      </button>
                      <button onClick={() => remove(n)} className="text-ink-slate hover:text-red-600" title="Delete">
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="px-3 py-2 border-t border-gray-100 space-y-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="Note for the reviewer / to fix before sending…"
              className="w-full text-xs px-2 py-1.5 rounded border border-gray-200 outline-none focus:border-amber-400 text-navy"
            />
            {err && <div className="text-[11px] text-red-600">{err}</div>}
            <button
              onClick={add}
              disabled={busy || !draft.trim()}
              className="w-full inline-flex items-center justify-center gap-1 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-3 py-1.5 rounded disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add note
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-full bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2.5 shadow-lg"
        >
          <StickyNote size={15} /> Reviewer notes
          {openCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-white text-amber-700 text-[10px] font-bold">
              {openCount}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
