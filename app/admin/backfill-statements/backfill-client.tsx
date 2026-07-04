"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, Send } from "lucide-react";

const PERIOD = "2026-05";

// Group A — completed May 2026 run, never sent (pulled 2026-06-23). XPaint first
// so it's the obvious pilot.
const CLIENTS: { id: string; name: string; bs: boolean }[] = [
  { id: "aa6ec66c-671d-42a8-8e41-4a71ca3bbc8e", name: "XPaint LLC", bs: false },
  { id: "7ec0b68a-7513-41bd-a450-7b6672b2ffe4", name: "Zuno Painting LLC", bs: false },
  { id: "74cb960b-6c4a-4d91-8ad3-bbbf169d03d0", name: "BMD Painting Ltd", bs: false },
  { id: "e0e5b062-21b8-4ef4-9a4f-5d817d6eb2cc", name: "Baldwin & Co. Painting and Finishing", bs: false },
  { id: "6f7f4b1a-3b65-435c-a22e-19863c7b4786", name: "Charles and Crew Painting", bs: false },
  { id: "68f56064-089b-467b-84af-9fd84f7dcbc3", name: "LT Woodworks", bs: false },
  { id: "b899d5d3-acd6-49d3-bc77-295c7c267f69", name: "Blessent Building LLC", bs: false },
  { id: "737197cd-c95f-4778-b65e-1dcb4f518b47", name: "Top Notch Painters LLC", bs: false },
  { id: "71b7df55-3860-4d46-953f-22d67df5a4d7", name: "Final Coat Painting Inc", bs: false },
  { id: "5a0f110e-a643-437f-9e6b-885c613b6b3f", name: "Brittney Tough", bs: false },
  { id: "195f745b-b9e8-4c60-8757-326cd8e84f5a", name: "Cliff Kranenburg Painting Inc.", bs: false },
  { id: "0c074545-7744-4d4f-aea1-b82eec237637", name: "Rock Bound Painting Ltd.", bs: true },
  { id: "0493a24f-fd5d-47b8-bd98-6c43ab33e51d", name: "Power Painting Plus Corp", bs: false },
  { id: "bac48b9e-1a30-4826-afad-dab89c253099", name: "Exivisual DecoPainting Corp.", bs: false },
  { id: "2b090550-6cdc-4316-b1e4-871174c1129b", name: "Make It Happen Painting", bs: false },
  { id: "74598ad0-5b3a-43aa-bb70-8fe9fd9f296b", name: "Amundson Custom Painting LLC", bs: false },
  { id: "eaa1b6a8-c4c9-4637-8355-607197f3e7db", name: "On A Roll", bs: true },
  { id: "0a9a03c9-02b9-47af-823c-008e99dc60e5", name: "Premier Pro Painters Home Improvement LLC", bs: false },
  { id: "344bb006-79a7-46fc-b55f-8a9b2a1885ae", name: "Despres Painting LLC", bs: true },
  { id: "016f0b93-8584-4604-984f-f4ea1396f60d", name: "James Painting LLC", bs: false },
  { id: "7c294609-269d-444f-8159-2357501d5b43", name: "Lionetti Painting", bs: false },
  { id: "4a3bbcda-881a-414d-8432-7e07598942c5", name: "Neighborhood Painting, Inc.", bs: false },
  { id: "d9da3753-c999-440a-9cbe-1c82cf970874", name: "Imago Painting And Designs LTD", bs: false },
  { id: "5b296f35-7a8c-414a-a79d-6f56238098af", name: "Splash Painting LLC", bs: false },
  { id: "a7020d20-54ef-41e2-acd0-59bef29c235d", name: "KTP Painting Co LLC", bs: true },
];

type RowState = { status: "idle" | "sending" | "sent" | "error"; note?: string };

export function BackfillClient() {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [runningAll, setRunningAll] = useState(false);

  const set = (id: string, st: RowState) => setRows((p) => ({ ...p, [id]: st }));

  // Reopen the May close, then re-complete it — which now runs the full send
  // (build statements → portal notification → email → QBO closing date). Same
  // as a bookkeeper doing it by hand on the board. Every send is client-facing,
  // so a single-row send gets its own verification popup (send-all confirms
  // once for the batch), and the API requires attested: true.
  async function sendOne(id: string, batchConfirmed = false): Promise<boolean> {
    if (rows[id]?.status === "sent") return true; // don't double-send
    if (!batchConfirmed) {
      const name = CLIENTS.find((c) => c.id === id)?.name || "this client";
      if (!confirm(`Send ${name} their May 2026 statements?\n\nThis publishes to their portal and EMAILS the client. It can't be unsent.`)) {
        return false;
      }
    }
    set(id, { status: "sending" });
    try {
      const reopen = await fetch(`/api/clients/${id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen", period: PERIOD }),
      });
      if (!reopen.ok) {
        const j = await reopen.json().catch(() => ({}));
        throw new Error(j.error || "reopen failed");
      }
      const res = await fetch(`/api/clients/${id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_complete", period: PERIOD, attested: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "send failed");
      const sent = j?.email_delivery?.sent;
      set(id, { status: "sent", note: sent ? "emailed + published" : "published (no portal email)" });
      return true;
    } catch (e: any) {
      set(id, { status: "error", note: e?.message || "failed" });
      return false;
    }
  }

  async function sendAll() {
    if (!confirm(`Send May 2026 statements to ALL ${CLIENTS.length} clients?\n\nThis publishes to each portal and EMAILS each client. This is client-facing and can't be undone.`)) return;
    setRunningAll(true);
    for (const c of CLIENTS) {
      if (rows[c.id]?.status === "sent") continue;
      // eslint-disable-next-line no-await-in-loop
      await sendOne(c.id, true);
    }
    setRunningAll(false);
  }

  const sentCount = Object.values(rows).filter((r) => r.status === "sent").length;
  const errCount = Object.values(rows).filter((r) => r.status === "error").length;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={sendAll}
          disabled={runningAll}
          className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-bold px-4 py-2.5 rounded-lg"
        >
          {runningAll ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Send all {CLIENTS.length}
        </button>
        <span className="text-sm text-ink-slate">
          {sentCount} sent{errCount ? ` · ${errCount} failed` : ""}
        </span>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 mb-4 text-xs text-amber-900 flex items-start gap-2">
        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
        Each send emails a real client their May 2026 statements and publishes to their portal. Pilot XPaint first, confirm it landed, then run the rest.
      </div>

      <ul className="space-y-1.5">
        {CLIENTS.map((c) => {
          const r = rows[c.id] || { status: "idle" };
          return (
            <li key={c.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2">
              <span className="flex-1 min-w-0 text-sm text-navy truncate">
                {c.name}
                {c.bs && <span className="ml-2 text-[10px] font-bold text-sky-700">full</span>}
              </span>
              {r.status === "sent" && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                  <CheckCircle2 size={13} /> {r.note}
                </span>
              )}
              {r.status === "error" && (
                <span className="inline-flex items-center gap-1 text-xs text-red-700" title={r.note}>
                  <AlertTriangle size={13} /> {r.note}
                </span>
              )}
              <button
                onClick={() => sendOne(c.id)}
                disabled={r.status === "sending" || r.status === "sent" || runningAll}
                className="inline-flex items-center gap-1.5 bg-navy hover:bg-navy/90 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex-shrink-0"
              >
                {r.status === "sending" ? <Loader2 size={12} className="animate-spin" /> : null}
                {r.status === "sent" ? "Sent" : "Send"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
