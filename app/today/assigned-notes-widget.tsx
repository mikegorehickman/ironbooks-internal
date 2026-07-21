"use client";

import { useState } from "react";
import Link from "next/link";
import { StickyNote, Check, Loader2 } from "lucide-react";

export interface AssignedNote {
  id: string;
  body: string;
  created_at: string;
  client_link_id: string;
  client_name: string;
  author: string;
}

/**
 * "Notes for you" — team notes another SNAP user assigned to the viewer, shown
 * on Home until they clear them. A teammate assigns a note on a client's
 * Notes tab; it lands here so nothing gets lost in a client the person might
 * not open that day. "Got it" marks it done (assignee_done_at).
 */
export function AssignedNotesWidget({ notes: initial }: { notes: AssignedNote[] }) {
  const [notes, setNotes] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  if (notes.length === 0) return null;

  async function clearNote(n: AssignedNote) {
    setBusy(n.id);
    try {
      const res = await fetch(`/api/clients/${n.client_link_id}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_id: n.id, done: true }),
      });
      if (res.ok) setNotes((prev) => prev.filter((x) => x.id !== n.id));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-teal-border bg-teal-light/40 p-4">
      <div className="text-sm font-bold text-teal-dark mb-2 flex items-center gap-1.5">
        <StickyNote size={14} /> Notes for you ({notes.length})
      </div>
      <div className="space-y-2">
        {notes.map((n) => (
          <div key={n.id} className="rounded-lg border border-teal-border/60 bg-white px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <Link href={`/clients/${n.client_link_id}?tab=messages`} className="text-sm font-semibold text-navy hover:text-teal">
                {n.client_name}
              </Link>
              <button
                onClick={() => clearNote(n)}
                disabled={busy === n.id}
                className="shrink-0 inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-ink-slate hover:border-teal hover:text-teal disabled:opacity-50"
                title="Mark as read — clears it from your Home"
              >
                {busy === n.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Got it
              </button>
            </div>
            <p className="text-sm text-navy whitespace-pre-wrap mt-0.5">{n.body}</p>
            <div className="text-[11px] text-ink-light mt-1">
              from {n.author} · {new Date(n.created_at).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
