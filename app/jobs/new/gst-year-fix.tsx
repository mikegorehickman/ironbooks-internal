"use client";

import { useState } from "react";
import { Loader2, Receipt, AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";
import Link from "next/link";

/**
 * Full-year GST/HST retrofit, offered inside the per-client cleanup setup.
 *
 * Sales tax doesn't respect a cleanup window. If a Canadian client has never
 * had GST/HST pulled out, cleaning one month leaves the other eleven with tax
 * buried inside revenue and expenses — the return is wrong and the P&L is
 * overstated on both sides. So the fix has to run over the whole year ONCE,
 * independently of whatever window the cleanup job itself is scoped to. After
 * that the monthly close keeps it current in the same format.
 *
 * Preview is read-only. Applying splits each transaction's lines so the
 * totals are unchanged — income moves to GST/HST Payable, expenses to the ITC
 * asset — and is senior-only + dry-run-by-default at the API.
 */

const fmt = (n: number) => "$" + Math.abs(Math.round(n || 0)).toLocaleString();

export function GstYearFix({
  clientLinkId,
  clientName,
  province,
}: {
  clientLinkId: string;
  clientName: string;
  province: string;
}) {
  const year = new Date().getUTCFullYear();
  const [start, setStart] = useState(`${year}-01-01`);
  const [end] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body: any, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api/admin/gst-extraction/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId, start, end, ...body }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    } catch (e: any) {
      setError(e?.message || "Failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const totals = preview?.totals || null;
  const nothingToDo = preview && (preview.deposit_count || 0) === 0 && (preview.expense_count || 0) === 0;

  return (
    <div className="rounded-xl border-2 border-gold-border bg-gold-tint/40 p-4">
      <div className="flex items-center gap-2">
        <Receipt size={15} className="text-gold-deep" />
        <span className="text-sm font-bold text-navy">GST/HST — full-year fix</span>
        <span className="text-[10px] font-bold uppercase tracking-wide bg-white border border-gold-border text-gold-deep px-1.5 py-0.5 rounded">
          {province || "CA"}
        </span>
      </div>
      <p className="text-xs text-ink-slate mt-1.5">
        Sales tax doesn&apos;t respect a cleanup window. If {clientName} has never had GST/HST pulled
        out, cleaning one month leaves the rest of the year with tax buried in revenue and expenses.
        Run this <strong>once for the year</strong> — the monthly close keeps it current afterwards.
        Totals never change: each transaction is split, income to GST/HST Payable and expenses to
        the ITC asset.
      </p>

      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        <label className="text-[11px] text-ink-slate">From</label>
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="text-[11px] border border-gray-300 rounded-lg px-2 py-1"
        />
        <span className="text-[11px] text-ink-slate">→ {end}</span>
        <button
          onClick={async () => {
            setResult(null);
            const j = await call("preview", {}, "preview");
            if (j) setPreview(j);
          }}
          disabled={!!busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:border-teal disabled:opacity-50"
        >
          {busy === "preview" ? <Loader2 size={12} className="animate-spin" /> : <Receipt size={12} />}
          Preview the year
        </button>
      </div>

      {error && <div className="mt-2 text-xs text-red-700">{error}</div>}

      {preview && !result && (
        <div className="mt-3 rounded-lg bg-white border border-gold-border px-3 py-2.5">
          {nothingToDo ? (
            <div className="text-xs text-emerald-800 inline-flex items-center gap-1.5">
              <CheckCircle2 size={13} /> Nothing to split in this window — GST/HST already separated.
            </div>
          ) : (
            <>
              <div className="text-xs text-navy">
                <strong>{preview.deposit_count}</strong> income and{" "}
                <strong>{preview.expense_count}</strong> expense transaction(s) would be split
                {totals && (
                  <>
                    {" "}
                    · GST/HST collected <strong className="tabular-nums">{fmt(totals.gstHstCollected)}</strong>
                    {" "}· ITC <strong className="tabular-nums">{fmt(totals.itcTotal)}</strong>
                    {totals.pstCollected > 0 && (
                      <> · PST <strong className="tabular-nums">{fmt(totals.pstCollected)}</strong></>
                    )}
                  </>
                )}
              </div>
              {preview.capped && (
                <div className="text-[11px] text-gold-deep mt-1">
                  Preview list is capped for display — the apply covers every matching transaction.
                </div>
              )}
              {(preview.heuristic_kinds?.length > 0 || preview.vendor_itc_summary?.length > 0) && (
                <div className="text-[11px] text-ink-slate mt-1.5 flex items-start gap-1">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0 text-gold-deep" />
                  <span>
                    Some accounts were classified by name, and small/unregistered suppliers can&apos;t
                    claim ITCs. Review the detail on the GST tool before applying if this client has
                    unusual vendors.
                  </span>
                </div>
              )}
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    if (
                      !confirm(
                        `Apply the GST/HST split for ${clientName}, ${start} → ${end}?\n\n` +
                          `${preview.deposit_count} income + ${preview.expense_count} expense transactions ` +
                          `will be split in their live QuickBooks. Totals are unchanged.`
                      )
                    )
                      return;
                    const j = await call("apply", { dry_run: false }, "apply");
                    if (j) setResult(j);
                  }}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#954E44] px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "apply" ? <Loader2 size={12} className="animate-spin" /> : <Receipt size={12} />}
                  Apply for the year
                </button>
                <Link
                  href={`/admin/gst-extraction?client=${clientLinkId}`}
                  className="text-[11px] font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
                >
                  Full detail + vendor exclusions <ArrowRight size={10} />
                </Link>
              </div>
            </>
          )}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-xs text-emerald-900">
          <div className="font-bold inline-flex items-center gap-1.5">
            <CheckCircle2 size={13} /> GST/HST split applied for {start} → {end}
          </div>
          <div className="mt-0.5">
            {(result.deposits?.planned_txns ?? 0) + (result.expenses?.planned_txns ?? 0)} transaction(s)
            processed
            {result.failures?.length ? ` · ${result.failures.length} failed` : ""}
            {result.remaining > 0
              ? ` · ${result.remaining} left — run it again to finish the batch.`
              : " · complete."}{" "}
            Carry on with the cleanup below; the monthly close keeps it current from here.
          </div>
        </div>
      )}
    </div>
  );
}
