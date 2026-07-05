"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ShieldCheck, Loader2, CheckCircle2, AlertTriangle, XCircle, MinusCircle,
  ChevronDown, ChevronUp, ArrowUpRight, RotateCcw,
} from "lucide-react";

/**
 * Books Reliability panel — the Close Review surface on the production card.
 * Runs the verification (read-only against QBO), renders the score dial +
 * pillar breakdown + findings with dismiss-with-reason, and the bank/CC
 * tie-out table. Dismissals recompute the score instantly (no QBO).
 */

type Finding = {
  fingerprint: string;
  severity: "warn" | "fail";
  message: string;
  amount?: number;
  account_name?: string;
  dismissable: boolean;
  senior_only?: boolean;
  dismissed?: { reason: string; by_name: string | null; at: string } | null;
};

type VCheck = {
  key: string;
  label: string;
  pillar: string;
  status: "pass" | "warn" | "fail" | "skipped";
  detail: string;
  findings: Finding[];
  fix?: string;
  meta?: any;
  skipReason?: string;
};

type Verification = {
  score: number;
  band: "certified" | "minor" | "not_ready";
  hardFail: boolean;
  pillars: { key: string; label: string; weight: number; score: number; skipped: boolean }[];
  checks: VCheck[];
  ranAt: string;
  stats?: { qboCalls: number; durationMs: number };
};

const BAND = {
  certified: { label: "Certified", color: "text-emerald-600", stroke: "#059669", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  minor: { label: "Minor items open", color: "text-amber-600", stroke: "#d97706", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  not_ready: { label: "Not ready to send", color: "text-red-600", stroke: "#dc2626", chip: "bg-red-50 text-red-700 border-red-200" },
};

export function vFixLink(fix: string | undefined, clientId: string): { href: string; label: string } | null {
  switch (fix) {
    case "reclass": return { href: `/reclass/new?client=${clientId}`, label: "Open Reclassify" };
    case "uf_audit": return { href: `/balance-sheet/${clientId}/uf-audit`, label: "Open UF Audit" };
    case "ar": return { href: `/clients/${clientId}`, label: "Open client profile" };
    case "profile": return { href: `/clients/${clientId}`, label: "Open client profile" };
    case "connections": return { href: "/fleet/qbo-health", label: "QBO Connections" };
    case "statements": return { href: `/clients/${clientId}`, label: "Statements on profile" };
    case "daily_queue": return { href: `/today/${clientId}`, label: "Open review queue" };
    default: return null;
  }
}

const fmtMoney = (n: number) =>
  `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function VStatusIcon({ status }: { status: VCheck["status"] }) {
  if (status === "pass") return <CheckCircle2 size={15} className="text-emerald-500 flex-shrink-0 mt-0.5" />;
  if (status === "warn") return <AlertTriangle size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />;
  if (status === "fail") return <XCircle size={15} className="text-red-500 flex-shrink-0 mt-0.5" />;
  return <MinusCircle size={15} className="text-slate-300 flex-shrink-0 mt-0.5" />;
}

function ScoreDial({ score, band }: { score: number; band: Verification["band"] }) {
  const b = BAND[band];
  const r = 30;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  return (
    <div className="relative w-[84px] h-[84px] flex-shrink-0">
      <svg viewBox="0 0 84 84" className="w-full h-full -rotate-90">
        <circle cx="42" cy="42" r={r} fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle
          cx="42" cy="42" r={r} fill="none"
          stroke={b.stroke} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`text-xl font-extrabold ${b.color}`}>{score}</span>
      </div>
    </div>
  );
}

export function VerificationPanel({
  clientId,
  period,
  verification,
  verificationRanAt,
  checksRanAt,
  isSenior,
  locked,
  onRun,
}: {
  clientId: string;
  period: string;
  verification: Verification | null;
  verificationRanAt: string | null;
  checksRanAt: string | null;
  isSenior: boolean;
  /** Complete/pending months: read-only (no re-verify, no dismissals). */
  locked: boolean;
  onRun: (run: any) => void;
}) {
  const [verifying, setVerifying] = useState(false);
  const [busyFp, setBusyFp] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [openChecks, setOpenChecks] = useState<Set<string>>(new Set());

  async function call(body: Record<string, unknown>) {
    const res = await fetch(`/api/clients/${clientId}/monthly-rec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, period }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.run;
  }

  async function verify() {
    setVerifying(true);
    setError("");
    try {
      onRun(await call({ action: "verify" }));
    } catch (e: any) {
      setError(e?.message || "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  async function dismiss(f: Finding, checkKey: string) {
    const reason = window.prompt(
      `Dismiss this finding for ${period} and future months?\n\n"${f.message}"\n\nWhy is this acceptable? (required — recorded with your name)`
    );
    if (!reason || !reason.trim()) return;
    setBusyFp(f.fingerprint);
    setError("");
    try {
      onRun(await call({ action: "dismiss_finding", fingerprint: f.fingerprint, check_key: checkKey, reason: reason.trim() }));
    } catch (e: any) {
      setError(e?.message || "Couldn't dismiss");
    } finally {
      setBusyFp(null);
    }
  }

  async function undismiss(f: Finding) {
    setBusyFp(f.fingerprint);
    setError("");
    try {
      onRun(await call({ action: "undismiss_finding", fingerprint: f.fingerprint }));
    } catch (e: any) {
      setError(e?.message || "Couldn't restore");
    } finally {
      setBusyFp(null);
    }
  }

  const v = verification;
  const stale = !!(v && checksRanAt && verificationRanAt && checksRanAt > verificationRanAt);
  const band = v ? BAND[v.band] : null;

  // Tie-out table rows from both tie-out checks.
  const tieRows: any[] = v
    ? v.checks
        .filter((c) => (c.key === "bank_tieout" || c.key === "cc_tieout") && Array.isArray(c.meta?.rows))
        .flatMap((c) => (c.meta.rows as any[]).map((r) => ({ ...r, kind: c.key === "cc_tieout" ? "Credit card" : "Bank" })))
    : [];

  return (
    <div className="bg-white border border-indigo-100 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2.5 bg-indigo-50/50 border-b border-indigo-100">
        <ShieldCheck size={15} className="text-indigo-600 flex-shrink-0" />
        <div className="text-sm font-bold text-navy">Books Reliability</div>
        {v && band && (
          <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${band.chip}`}>
            {band.label}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {v?.ranAt && (
            <span className="text-[10px] text-ink-light">
              verified {new Date(v.ranAt).toLocaleString()}
            </span>
          )}
          {!locked && (
            <button
              onClick={verify}
              disabled={verifying}
              className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold px-3 py-1.5 rounded-lg"
            >
              {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              {v ? "Re-verify" : "Verify books"}
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-3 space-y-3">
        {error && (
          <div className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" /> {error}
          </div>
        )}

        {!v ? (
          <p className="text-xs text-ink-slate leading-relaxed">
            Runs {`~15`} read-only checks against QuickBooks for {period}: statement tie-outs, categorization,
            balance-sheet integrity, duplicates and unusual swings — and scores the month 0-100.
            {verifying ? " Running…" : " Takes about 15 seconds."}
          </p>
        ) : (
          <>
            {stale && !locked && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                The quick checks ran after this verification — re-verify to make sure the score reflects the latest books.
              </div>
            )}

            <div className="flex items-center gap-4">
              <ScoreDial score={v.score} band={v.band} />
              <div className="flex-1 min-w-0 space-y-1.5">
                {v.pillars.filter((p) => !p.skipped).map((p) => (
                  <div key={p.key} className="flex items-center gap-2">
                    <span className="text-[11px] text-ink-slate w-40 truncate">{p.label}</span>
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${p.score >= 90 ? "bg-emerald-500" : p.score >= 60 ? "bg-amber-400" : "bg-red-400"}`}
                        style={{ width: `${p.score}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-semibold text-navy w-8 text-right">{p.score}</span>
                  </div>
                ))}
                {v.hardFail && (
                  <div className="text-[11px] font-semibold text-red-700">
                    A must-fix check is failing — the score is capped until it&apos;s resolved.
                  </div>
                )}
              </div>
            </div>

            <ul className="space-y-1.5">
              {v.checks.map((c) => {
                const open = openChecks.has(c.key);
                const link = vFixLink(c.fix, clientId);
                const hasBody = c.findings.length > 0 || c.status === "skipped";
                return (
                  <li key={c.key} className="bg-slate-50/60 border border-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() =>
                        hasBody &&
                        setOpenChecks((prev) => {
                          const n = new Set(prev);
                          n.has(c.key) ? n.delete(c.key) : n.add(c.key);
                          return n;
                        })
                      }
                      className={`w-full flex items-start gap-2 px-2.5 py-2 text-left ${hasBody ? "cursor-pointer" : "cursor-default"}`}
                    >
                      <VStatusIcon status={c.status} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-navy">{c.label}</div>
                        <div className="text-[11px] text-ink-slate">{c.status === "skipped" ? c.skipReason || c.detail : c.detail}</div>
                      </div>
                      {hasBody && (open ? <ChevronUp size={13} className="text-ink-light mt-1" /> : <ChevronDown size={13} className="text-ink-light mt-1" />)}
                    </button>
                    {open && c.findings.length > 0 && (
                      <ul className="px-2.5 pb-2 space-y-1">
                        {c.findings.map((f) => (
                          <li
                            key={f.fingerprint}
                            className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${
                              f.dismissed
                                ? "bg-slate-50 border-slate-200 text-slate-400"
                                : f.severity === "fail"
                                ? "bg-red-50/60 border-red-100 text-navy"
                                : "bg-amber-50/60 border-amber-100 text-navy"
                            }`}
                          >
                            <span className={`flex-1 min-w-0 ${f.dismissed ? "line-through" : ""}`}>
                              {f.message}
                              {f.dismissed && (
                                <span className="block no-underline text-[10px] italic mt-0.5">
                                  dismissed{f.dismissed.by_name ? ` by ${f.dismissed.by_name}` : ""}: {f.dismissed.reason}
                                </span>
                              )}
                            </span>
                            {!locked && f.dismissed && (
                              <button
                                onClick={() => undismiss(f)}
                                disabled={busyFp === f.fingerprint}
                                className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 hover:text-navy flex-shrink-0"
                              >
                                {busyFp === f.fingerprint ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                                restore
                              </button>
                            )}
                            {!locked && !f.dismissed && f.dismissable && (!f.senior_only || isSenior) && (
                              <button
                                onClick={() => dismiss(f, c.key)}
                                disabled={busyFp === f.fingerprint}
                                title={f.senior_only ? "Senior dismissal" : "Dismiss with a reason — remembered for future months"}
                                className="text-[10px] font-bold text-slate-500 hover:text-navy flex-shrink-0"
                              >
                                {busyFp === f.fingerprint ? <Loader2 size={10} className="animate-spin" /> : "dismiss"}
                              </button>
                            )}
                          </li>
                        ))}
                        {link && (
                          <li>
                            <Link href={link.href} className="inline-flex items-center gap-1 text-[11px] font-bold text-teal hover:underline">
                              {link.label} <ArrowUpRight size={10} />
                            </Link>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>

            {tieRows.length > 0 && (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-2.5 py-1.5 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-ink-slate">
                  Statement tie-out — {period}
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-ink-light border-b border-slate-100">
                      <th className="text-left font-semibold px-2.5 py-1">Account</th>
                      <th className="text-right font-semibold px-2.5 py-1">QBO</th>
                      <th className="text-right font-semibold px-2.5 py-1">Statement</th>
                      <th className="text-right font-semibold px-2.5 py-1">Diff</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {tieRows.map((r) => (
                      <tr key={`${r.kind}-${r.account_id}`}>
                        <td className="px-2.5 py-1 text-navy truncate max-w-[160px]">{r.account_name}</td>
                        <td className="px-2.5 py-1 text-right text-navy">{fmtMoney(Number(r.qbo || 0))}</td>
                        <td className="px-2.5 py-1 text-right text-navy">{r.covered ? fmtMoney(Number(r.stmt || 0)) : "no statement"}</td>
                        <td className={`px-2.5 py-1 text-right font-semibold ${!r.covered ? "text-slate-400" : Number(r.diff) <= 1 ? "text-emerald-600" : "text-red-600"}`}>
                          {r.covered ? fmtMoney(Number(r.diff || 0)) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
