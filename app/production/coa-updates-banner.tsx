"use client";

import { useEffect, useState } from "react";
import { Sparkles, Loader2, ChevronDown, ChevronUp } from "lucide-react";

interface NewCat {
  account_name: string;
  section: string;
}

/**
 * Month-end "new COA categories available" banner. Shown on the selected
 * client's close view. If the client was cleaned BEFORE categories were added
 * to the master COA, this lists them and offers a one-click re-scan:
 *   1. POST coa-updates/apply  → creates the new accounts in their QBO
 *   2. POST /api/reclass/discover (full_categorization) → AI suggests moves
 *   3. navigate to the reclass job for approve/decline
 * Reuses the existing, tested reclass flow for the actual categorization.
 */
export function CoaUpdatesBanner({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [loading, setLoading] = useState(true);
  const [cats, setCats] = useState<NewCat[]>([]);
  const [jurisdiction, setJurisdiction] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/clients/${clientId}/coa-updates`)
      .then((r) => r.json())
      .then((b) => {
        if (!alive) return;
        setCats(b.categories || []);
        setJurisdiction(b.jurisdiction || null);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [clientId]);

  if (loading || cats.length === 0) return null;

  async function applyAndRescan() {
    if (
      !confirm(
        `Apply ${cats.length} new COA categor${cats.length === 1 ? "y" : "ies"} to ${clientName}?\n\n` +
          `This will:\n` +
          `1. Create the new accounts in ${clientName}'s QuickBooks\n` +
          `2. Start an AI categorization pass so transactions can be moved into them\n\n` +
          `You'll review and approve each suggested move in the reclass screen — nothing posts automatically.`
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const ar = await fetch(`/api/clients/${clientId}/coa-updates/apply`, { method: "POST" });
      const ab = await ar.json();
      if (!ar.ok) throw new Error(ab.error || "Couldn't create the new accounts");

      const now = new Date();
      const start = `${now.getFullYear()}-01-01`;
      const end = now.toISOString().slice(0, 10);
      const dr = await fetch(`/api/reclass/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientId,
          workflow: "full_categorization",
          date_range_start: start,
          date_range_end: end,
          jurisdiction,
          auto_approve_threshold: 95,
        }),
      });
      const db = await dr.json();
      if (!dr.ok) {
        // Accounts were created; only the AI pass failed (e.g. a reclass job is
        // already running). Surface it and let them open that job manually.
        throw new Error(
          (db.error || "Accounts created, but couldn't start the AI pass") +
            (db.existing_job_id ? ` (open job ${db.existing_job_id})` : "")
        );
      }
      window.location.href = `/reclass/${db.job_id || db.id}`;
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div className="bg-teal-light border-2 border-teal-border rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="p-1.5 rounded-lg bg-teal-light flex-shrink-0">
          <Sparkles size={16} className="text-teal-dark" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-teal-dark">
            {cats.length} new COA categor{cats.length === 1 ? "y" : "ies"} available since this client's cleanup
          </div>
          <p className="text-xs text-teal-dark/80 mt-0.5">
            {clientName} was cleaned on the older chart. Create the new accounts and let the AI
            suggest transactions to move into them.
          </p>

          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-teal-dark hover:text-teal-dark"
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {expanded ? "Hide" : "Show"} the new categories
          </button>
          {expanded && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cats.map((c) => (
                <span
                  key={c.account_name}
                  className="text-[11px] font-semibold bg-white border border-teal-border text-teal-dark px-2 py-0.5 rounded-full"
                >
                  {c.account_name}
                </span>
              ))}
            </div>
          )}

          {error && (
            <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
          )}

          <div className="mt-3">
            <button
              onClick={applyAndRescan}
              disabled={busy}
              className="inline-flex items-center gap-1.5 bg-navy hover:bg-navy-deep text-white text-xs font-bold px-3.5 py-1.5 rounded-lg disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {busy ? "Creating accounts & starting AI…" : "Create accounts & re-scan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
