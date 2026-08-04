"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Zap, AlertTriangle } from "lucide-react";

/**
 * One click for every payment SNAP already matched to a real bank deposit.
 *
 * Two-step on purpose. Step one is a dry run that shows exactly what would be
 * staged and what would be skipped; step two stages it. Neither step writes to
 * QuickBooks — Finalize stays the single write path, so there is always one
 * deliberate human action between a heuristic and a posted Deposit.
 *
 * The work this removes is not the judgement, it is the clerical part: finalize
 * rejects a create_deposit item with no bank account, and the scan only stores
 * the bank's NAME, so a bookkeeper who fully agreed with the match still had to
 * pick the bank and the date by hand for every group. Three times on
 * RocketPainter; sixty-one times on Clean Cut.
 */
export function AutoApplyMatchesButton({
  clientLinkId,
  scanId,
  disabled,
}: {
  clientLinkId: string;
  scanId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);

  const money = (n: number) =>
    `$${Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function call(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/uf-audit/${scanId}/auto-apply-matches`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dry_run: dryRun }),
        }
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `Failed (${res.status})`);
      if (dryRun) setPreview(j);
      else {
        setDone(j);
        setPreview(null);
        router.refresh();
      }
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-teal/30 bg-teal-lighter/30 px-4 py-3 text-xs text-teal-dark">
        <strong>
          Staged {done.applied} payment{done.applied === 1 ? "" : "s"} ({money(done.would_apply_total)}){" "}
          as bank deposits.
        </strong>{" "}
        Nothing has been written to QuickBooks yet — press <strong>Finalize</strong> below to post
        them.
        {done.errors?.length > 0 && (
          <div className="mt-1 text-[#954E44]">
            {done.errors.length} could not be staged: {done.errors.join("; ")}
          </div>
        )}
      </div>
    );
  }

  if (preview) {
    const nothing = preview.would_apply === 0;
    return (
      <div className="rounded-lg border-2 border-teal/40 bg-white px-4 py-3 text-xs">
        {nothing ? (
          <div className="text-ink-slate">
            <strong className="text-navy">Nothing to auto-apply.</strong> No orphan has an exact
            bank-deposit match at 90%+ confidence.
            {preview.skipped && (
              <div className="mt-1 text-[11px]">
                Skipped: {preview.skipped.no_match} with no match · {preview.skipped.duplicate}{" "}
                duplicates · {preview.skipped.not_exact} non-exact ties ·{" "}
                {preview.skipped.low_confidence} below 90% · {preview.skipped.already_resolved}{" "}
                already resolved.
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="font-bold text-navy">
              Stage {preview.would_apply} payment{preview.would_apply === 1 ? "" : "s"} —{" "}
              {money(preview.would_apply_total)}
            </div>
            <div className="text-ink-slate mt-1 leading-relaxed">
              Each gets resolution <strong>create bank deposit</strong>, with the bank and date from
              the deposit SNAP matched it to. This writes nothing to QuickBooks — Finalize still
              does that.
            </div>
            <div className="mt-2 max-h-40 overflow-y-auto border border-gray-100 rounded">
              <table className="w-full text-[11px]">
                <tbody>
                  {(preview.items || []).map((i: any, n: number) => (
                    <tr key={n} className="border-b border-gray-50 last:border-0">
                      <td className="px-2 py-1 text-navy font-medium">{i.customer}</td>
                      <td className="px-2 py-1 text-right font-mono">{money(i.amount)}</td>
                      <td className="px-2 py-1 text-ink-slate">
                        → {i.bank} on {i.deposit_date}
                      </td>
                      <td className="px-2 py-1 text-ink-light">
                        {i.confidence != null ? `${Math.round(i.confidence * 100)}%` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.unresolved_bank?.length > 0 && (
              <div className="mt-2 flex items-start gap-1.5 text-[11px] text-[#8A6D2F]">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                <span>
                  {preview.unresolved_bank.length} match
                  {preview.unresolved_bank.length === 1 ? "" : "es"} skipped — couldn&apos;t tie the
                  deposit&apos;s bank name to one QBO account (
                  {preview.unresolved_bank
                    .slice(0, 3)
                    .map((u: any) => u.bank_name || "unnamed")
                    .join(", ")}
                  ). Resolve those by hand.
                </span>
              </div>
            )}
            {preview.skipped && (
              <div className="mt-1.5 text-[11px] text-ink-slate">
                Left alone: {preview.skipped.duplicate} duplicate
                {preview.skipped.duplicate === 1 ? "" : "s"} (depositing one would bank the money
                twice) · {preview.skipped.no_match} with no deposit found ·{" "}
                {preview.skipped.not_exact} bundled/tax-adjusted ties.
              </div>
            )}
          </>
        )}
        <div className="flex items-center gap-2 mt-3">
          {!nothing && (
            <button
              onClick={() => call(false)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-1.5 rounded disabled:opacity-50"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
              Stage {preview.would_apply} deposit{preview.would_apply === 1 ? "" : "s"}
            </button>
          )}
          <button
            onClick={() => setPreview(null)}
            className="text-xs font-semibold text-ink-slate hover:text-navy"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => call(true)}
        disabled={busy || disabled}
        title="Stage every payment SNAP matched to a real bank deposit — preview first, and nothing posts to QuickBooks until you Finalize"
        className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-1.5 rounded-md disabled:opacity-50"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
        Auto-apply matched deposits
      </button>
      {error && <div className="text-[11px] text-[#954E44] mt-1">{error}</div>}
    </div>
  );
}
