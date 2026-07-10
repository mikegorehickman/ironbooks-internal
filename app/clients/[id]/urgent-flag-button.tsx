"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Siren } from "lucide-react";

/**
 * Urgent-support flag — "books needed ASAP". Toggles from the profile action
 * bar; boards badge flagged clients red and float them to the top.
 */
export function UrgentFlagButton({
  clientLinkId,
  initialUrgent,
  initialNote,
}: {
  clientLinkId: string;
  initialUrgent: boolean;
  initialNote: string | null;
}) {
  const router = useRouter();
  const [urgent, setUrgent] = useState(initialUrgent);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    let newNote: string | null = null;
    if (!urgent) {
      const input = window.prompt("Flag as URGENT — why? (shown on the boards)", note || "");
      if (input === null) return; // cancelled
      newNote = input.trim() || null;
    } else if (!confirm("Clear the urgent flag for this client?")) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/urgent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urgent: !urgent, note: newNote }),
      });
      const j = await res.json();
      if (!res.ok) { alert(j.error || "Failed to update urgent flag"); return; }
      setUrgent(!urgent);
      setNote(newNote);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={urgent ? `URGENT${note ? `: ${note}` : ""} — click to clear` : "Flag this client as urgent (books ASAP)"}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold ${
        urgent
          ? "bg-red-600 border-red-600 text-white hover:bg-red-700"
          : "border-red-200 bg-white text-red-700 hover:bg-red-50"
      }`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Siren size={13} />}
      {urgent ? "URGENT — clear" : "Flag urgent"}
    </button>
  );
}
