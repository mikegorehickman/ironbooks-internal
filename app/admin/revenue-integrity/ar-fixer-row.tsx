"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronRight, Wrench, ExternalLink } from "lucide-react";
import { QboRemediationPanel } from "@/components/QboRemediationPanel";
import { ClientConfirmPanel } from "./client-confirm-panel";

/**
 * One client row on the fleet integrity board, with the remediation tool
 * folded in so an admin can fix from here instead of opening every client.
 *
 * DELIBERATELY per-client and expand-one-at-a-time. There is no fleet-wide
 * "fix everything" button and there should not be: the 2026-07 Clean Cut
 * incident was exactly that shape (a Fix-all silently overwrote a completed
 * cleanup). Every write still goes through /api/admin/crm-invoice-remediation
 * — admin/lead only, dry-run by default, QBO closing-date enforced, pre-edit
 * snapshots to audit_log.
 *
 * Closed-fiscal-year invoices are surfaced but NOT fixable here: the cash was
 * collected in a filed year, so the correct entry is a prior-period
 * adjustment to equity with CPA sign-off — never a current-period write-off
 * and never a back-dated match into closed books.
 */

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();

export function ArFixerRow({
  clientId,
  clientName,
  ar,
  rev,
}: {
  clientId: string;
  clientName: string;
  ar: any | null;
  rev: any | null;
}) {
  const [open, setOpen] = useState(false);
  const bad = ar?.verdict === "unreliable";
  const fixable = !!(ar?.flagged || rev?.flagged);

  // Pairing window. Deposits that paid a 2022 invoice live in 2022, so the
  // default YTD window would find nothing — widen to the oldest open invoice.
  const today = new Date().toISOString().slice(0, 10);
  const oldest = ar?.oldest_date ? String(ar.oldest_date).slice(0, 10) : null;
  const thisYear = `${new Date().getFullYear()}-01-01`;
  const twoYears = `${new Date().getFullYear() - 2}-01-01`;
  const WINDOWS = [
    ...(oldest && oldest < twoYears
      ? [{ key: "oldest", label: `Since oldest invoice (${oldest})`, start: oldest }]
      : []),
    { key: "2y", label: `Last 2 years (${twoYears})`, start: twoYears },
    { key: "ytd", label: "This year", start: thisYear },
  ];
  const [winKey, setWinKey] = useState(WINDOWS[0].key);
  const start = (WINDOWS.find((w) => w.key === winKey) || WINDOWS[0]).start;

  return (
    <>
      <tr
        className={`border-b border-gray-50 ${
          bad ? "bg-red-50/40" : ar?.flagged ? "bg-amber-50/30" : ""
        } ${open ? "border-b-0" : "last:border-0"}`}
      >
        <td className="px-4 py-2.5 align-top">
          <Link href={`/clients/${clientId}`} className="font-semibold text-navy hover:text-teal hover:underline">
            {clientName}
          </Link>
          <div className="flex flex-wrap gap-1 mt-1">
            {ar && <ArBadge verdict={ar.verdict} />}
            {ar?.deposits_only && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-ink-slate">
                deposits-only
              </span>
            )}
            {rev?.flagged && (
              <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                <AlertTriangle size={10} /> double-count
              </span>
            )}
          </div>
          {ar?.reason && <div className="text-[11px] text-ink-slate mt-1 max-w-[440px]">{ar.reason}</div>}
        </td>
        <td className="px-3 py-2.5 text-right align-top font-semibold text-navy tabular-nums">
          {ar ? (
            <>
              {fmt(ar.total_open)} <span className="text-[10px] font-normal text-ink-light">({ar.total_count})</span>
            </>
          ) : (
            <span className="text-ink-light">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-top tabular-nums">
          {ar ? (
            <span className={ar.pct_over_90 >= 70 ? "font-semibold text-red-700" : "text-ink-slate"}>
              {Math.round(ar.pct_over_90)}%
            </span>
          ) : (
            <span className="text-ink-light">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-top text-ink-slate tabular-nums">
          {ar?.oldest_days != null ? `${Number(ar.oldest_days).toLocaleString()}d` : "—"}
        </td>
        <td className="px-3 py-2.5 text-right align-top text-ink-slate tabular-nums">
          {ar?.prior_year_total ? (
            <>
              {fmt(ar.prior_year_total)}{" "}
              <span className="text-[10px] text-ink-light">({ar.prior_year_count})</span>
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-top tabular-nums">
          {ar?.ar_to_monthly_revenue != null ? (
            <span className={ar.ar_to_monthly_revenue > 6 ? "font-semibold text-red-700" : "text-ink-slate"}>
              {ar.ar_to_monthly_revenue}×
            </span>
          ) : (
            <span className="text-ink-light">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right align-top text-ink-slate tabular-nums">
          {rev ? (
            <>
              {fmt(rev.deposit_total)}{" "}
              <span className="text-[10px] text-ink-light">({rev.deposit_count})</span>
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2.5 align-top text-right">
          {fixable ? (
            <button
              onClick={() => setOpen((o) => !o)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                open
                  ? "border-teal bg-teal text-white"
                  : "border-gray-200 bg-white text-navy hover:border-teal hover:text-teal"
              }`}
            >
              <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
              <Wrench size={12} /> Fix
            </button>
          ) : (
            <span className="text-[11px] text-ink-light">—</span>
          )}
        </td>
      </tr>

      {open && (
        <tr className="border-b border-gray-100 bg-gray-50/60">
          <td colSpan={8} className="px-4 py-4">
            {/* Closed years — not fixable here, by design. */}
            {ar?.prior_year_total > 0 && (
              <div className="mb-3 rounded-xl border border-gold-border bg-gold-tint px-3 py-2.5 text-[12.5px] text-[#7c5210]">
                <div className="font-bold flex items-center gap-1.5">
                  <AlertTriangle size={13} />
                  {fmt(ar.prior_year_total)} across {ar.prior_year_count} invoice
                  {ar.prior_year_count === 1 ? "" : "s"} sits in closed fiscal years (before{" "}
                  {ar.fiscal_year_start}) — not fixable here
                </div>
                <p className="mt-1">
                  That cash was collected in a filed year. Matching a deposit back into closed books is
                  wrong, and a write-off is worse — it asserts &ldquo;never collected&rdquo; and lands the
                  hit in the current period. The correct entry is a{" "}
                  <strong>prior-period adjustment (Dr Retained Earnings / Cr A/R)</strong> with CPA
                  sign-off, which also corrects the equity overstatement if the deposit was booked to
                  revenue at the time. The tool below deliberately skips anything in a closed period.
                </p>
              </div>
            )}

            {/* Pairing window — old invoices need an old window or nothing pairs. */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">
                Pairing window
              </span>
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  onClick={() => setWinKey(w.key)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                    winKey === w.key
                      ? "bg-teal text-white border-teal"
                      : "bg-white text-ink-slate border-gray-200 hover:border-teal/50"
                  }`}
                >
                  {w.label}
                </button>
              ))}
              <span className="text-[11px] text-ink-light">
                → {today} · wider windows pull more P&amp;L detail and take longer
              </span>
            </div>

            <QboRemediationPanel
              clientLinkId={clientId}
              clientName={clientName}
              start={start}
              end={today}
            />

            {/* The client-assisted leg: send the ambiguous residual to the
                client to confirm, action their answers here. */}
            <ClientConfirmPanel clientId={clientId} clientName={clientName} />

            <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
              <Link
                href={`/revenue-check/${clientId}`}
                className="inline-flex items-center gap-1 font-semibold text-teal hover:text-teal-dark"
              >
                Full revenue &amp; A/R check <ExternalLink size={10} />
              </Link>
              <Link
                href={`/balance-sheet/${clientId}/ufar-recon`}
                className="inline-flex items-center gap-1 font-semibold text-teal hover:text-teal-dark"
              >
                UF / A/R Reconciler <ExternalLink size={10} />
              </Link>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ArBadge({ verdict }: { verdict: string }) {
  if (verdict === "unreliable") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
        <AlertTriangle size={10} /> A/R not trustworthy
      </span>
    );
  }
  if (verdict === "suspect") {
    return (
      <span className="inline-flex items-center rounded-full border border-gold-border bg-gold-tint px-1.5 py-0.5 text-[10px] font-semibold text-gold-deep">
        A/R questionable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
      A/R clean
    </span>
  );
}
