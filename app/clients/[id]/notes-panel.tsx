"use client";

import { useEffect, useState } from "react";
import { Loader2, StickyNote, Trash2, Plus } from "lucide-react";

interface Note {
  id: string;
  body: string;
  created_at: string;
  author_id: string;
  author: string;
}

/** Internal per-client notes — free-form, newest first. Never client-visible. */
export function NotesPanel({ clientLinkId }: { clientLinkId: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/notes`);
      const j = await res.json();
      if (res.ok) setNotes(j.notes || []);
      else setError(j.error || "Failed to load notes");
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function add() {
    if (!draft.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Failed to save");
      setDraft("");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm("Delete this note?")) return;
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/notes?note_id=${id}`, { method: "DELETE" });
      if (res.ok) setNotes((prev) => (prev || []).filter((n) => n.id !== id));
    } catch { /* refresh will reconcile */ }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="px-5 py-4 border-b border-gray-200">
        <h3 className="font-bold text-navy flex items-center gap-2">
          <StickyNote size={16} className="text-teal" /> Notes
        </h3>
        <p className="text-xs text-ink-slate mt-0.5">
          Internal team notes for this client — context, quirks, promises made. Never visible to the client.
        </p>
      </div>
      <div className="p-5 space-y-3">
        <div className="flex items-start gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder="Add a note… (e.g. prefers text over email; CPA is Smith & Co; promised statements by the 5th)"
            className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none"
          />
          <button
            onClick={add}
            disabled={busy || !draft.trim()}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-xs font-bold px-3 py-2 rounded-lg"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
          </button>
        </div>
        {error && <div className="text-xs text-red-700">{error}</div>}

        {notes === null ? (
          <div className="text-xs text-ink-light flex items-center gap-1.5 py-2">
            <Loader2 size={12} className="animate-spin" /> Loading notes…
          </div>
        ) : notes.length === 0 ? (
          <div className="text-xs text-ink-light py-2">No notes yet.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {notes.map((n) => (
              <div key={n.id} className="py-2.5 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-navy whitespace-pre-wrap">{n.body}</div>
                  <div className="text-[11px] text-ink-light mt-1">
                    {n.author} · {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
                <button onClick={() => remove(n.id)} className="p-1 text-ink-light hover:text-red-600 flex-shrink-0" title="Delete note">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
