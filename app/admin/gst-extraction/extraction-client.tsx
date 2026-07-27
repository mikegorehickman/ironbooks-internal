"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Loader2, AlertTriangle, ChevronDown, ChevronRight, ExternalLink,
  CheckCircle2, Eye, Play, ShieldCheck,
} from "lucide-react";

interface ClientRow {
  id: string;
  client_name: string;
  province: string | null;
  gst_number: string | null;
  live: boolean;
}

interface VendorItc { vendor: string; itc: number; lines: number }
interface HeuristicKind { account: string; kind: string }

interface Preview {
  client_name: string;
  province: string;
  gst_number: string | null;
  window: { start: string; end: string };
  totals: {
    incomeGross: number;
    incomeNet: number;
    gstHstCollected: number;
    pstCollected: number;
    expenseGross: number;
    itcTotal: number;
  };
  accounts: any;
  heuristic_kinds?: HeuristicKind[];
  vendor_itc_summary?: VendorItc[];
  deposit_count: number;
  expense_count: number;
  capped?: boolean;
  skipped?: {
    alreadySplitTxns: number;
    nonRecoverableLines: number;
    unknownAccounts: string[];
    excludedVendorLines: number;
  };
}

interface ApplySummary {
  dry_run: boolean;
  side: string;
  accounts: { payable?: string; recoverable?: string; pst_payable?: string; created?: string[] };
  deposits: { planned_txns: number; split: number; would_split: number; failed: number; skipped_already: number; skipped_closed: number; skipped_stale: number };
  expenses: { planned_txns: number; split: number; would_split: number; failed: number; skipped_already: number; skipped_closed: number; skipped_stale: number };
  remaining: number;
  done: boolean;
  failures?: any[];
}

const money = (n: number | undefined) =>
  `$${Math.abs(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Passes are capped so a runaway loop can't hammer QBO — each pass writes up
 *  to 40 transactions, so 60 passes covers ~2,400 per client per click. */
const MAX_PASSES = 60;

export function GstExtractionClient({ clients }: { clients: ClientRow[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview | { error: string }>>({});
  const [excluded, setExcluded] = useState<Record<string, Set<string>>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, ApplySummary>>({});

  function toggle(id: string) {
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function preview(id: string) {
    setPreviewing(id);
    try {
      const res = await fetch("/api/admin/gst-extraction/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: id, exclude_vendors: [...(excluded[id] || [])] }),
      });
      const j = await res.json();
      setPreviews((p) => ({ ...p, [id]: res.ok ? j : { error: j.error || "preview failed" } }));
      setExpanded((s) => new Set(s).add(id));
    } catch (e: any) {
      setPreviews((p) => ({ ...p, [id]: { error: e?.message || "preview failed" } }));
    } finally {
      setPreviewing(null);
    }
  }

  /** One apply run: loops chunked passes until the server reports done. */
  async function apply(id: string, side: "income" | "expenses", dryRun: boolean) {
    const pv = previews[id] as Preview | undefined;
    const name = pv?.client_name || clients.find((c) => c.id === id)?.client_name || "this client";
    if (!dryRun) {
      const amount = side === "income"
        ? money(pv?.totals?.gstHstCollected)
        : money(pv?.totals?.itcTotal);
      const label = side === "income" ? "sales tax out of revenue" : "ITCs out of expenses";
      const okGo = window.confirm(
        `WRITE TO QUICKBOOKS for ${name}?\n\n` +
        `This splits ${label} across 2026-YTD transactions (about ${amount}).\n\n` +
        `Transaction totals never change. Every edit is snapshotted first and re-runs are safe.\n\n` +
        `Continue?`
      );
      if (!okGo) return;
    }

    setRunning(id);
    let totalSplit = 0;
    let totalFailed = 0;
    let last: ApplySummary | null = null;
    try {
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        setProgress((p) => ({
          ...p,
          [id]: `${dryRun ? "Dry run" : "Applying"} ${side} — pass ${pass}${totalSplit ? ` · ${totalSplit} done` : ""}…`,
        }));
        const res = await fetch("/api/admin/gst-extraction/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_link_id: id,
            side,
            dry_run: dryRun,
            exclude_vendors: [...(excluded[id] || [])],
          }),
        });
        const j: ApplySummary = await res.json();
        if (!res.ok) throw new Error((j as any).error || "apply failed");
        last = j;
        totalSplit += (j.deposits?.split || 0) + (j.expenses?.split || 0);
        totalFailed += (j.deposits?.failed || 0) + (j.expenses?.failed || 0);
        setResults((r) => ({
          ...r,
          [id]: { ...j, deposits: { ...j.deposits }, expenses: { ...j.expenses } },
        }));
        // Dry runs plan the whole window in one pass — no need to loop.
        if (dryRun || j.done) break;
        if (pass === MAX_PASSES) {
          setProgress((p) => ({ ...p, [id]: `Stopped at the ${MAX_PASSES}-pass cap — ${j.remaining} left. Click again to continue.` }));
          return;
        }
      }
      const verb = dryRun ? "Dry run complete" : "Applied";
      setProgress((p) => ({
        ...p,
        [id]: `${verb}: ${side} — ${dryRun ? ((last?.deposits?.would_split || 0) + (last?.expenses?.would_split || 0)) + " would split" : totalSplit + " split"}${totalFailed ? ` · ${totalFailed} failed` : ""}.`,
      }));
      if (!dryRun) await preview(id); // refresh remaining state
    } catch (e: any) {
      setProgress((p) => ({ ...p, [id]: `Error: ${e?.message || "apply failed"}` }));
    } finally {
      setRunning(null);
    }
  }

  function toggleVendor(id: string, vendor: string) {
    setExcluded((e) => {
      const cur = new Set(e[id] || []);
      cur.has(vendor) ? cur.delete(vendor) : cur.add(vendor);
      return { ...e, [id]: cur };
    });
  }

  const previewed = clients.filter((c) => previews[c.id]);

  return (
    <div className="space-y-5">
      {/* How it works — the mechanism, in plain terms */}
      <div className="rounded-xl border border-teal-border bg-teal-lighter px-4 py-3 text-sm text-ink">
        <div className="font-semibold text-navy flex items-center gap-1.5">
          <ShieldCheck size={15} className="text-teal-dark" /> How this works
        </div>
        <ul className="text-xs mt-2 space-y-1 text-ink-slate list-disc pl-4">
          <li>
            Revenue deposits are split into <strong>net revenue + GST/HST Payable</strong> (a liability on the
            balance sheet). Taxable expenses are split into <strong>net expense + GST/HST Recoverable (ITCs)</strong>{" "}
            (an asset). PST is tracked separately where the province charges it.
          </li>
          <li>
            <strong>Transaction totals never change</strong> — only the line breakdown — so bank feeds, matches and
            reconciliations are untouched.
          </li>
          <li>
            Every edit is <strong>snapshotted to the audit log before the write</strong>, and re-runs are
            idempotent (each edited transaction is memo-stamped), so a second click can&apos;t double-split.
          </li>
          <li>
            Closed periods are skipped automatically. <strong>Preview and Dry run never write anything.</strong>
          </li>
        </ul>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-ink-slate">
          {clients.length} Canadian client{clients.length === 1 ? "" : "s"} with a QuickBooks connection
          {previewed.length > 0 && <> · {previewed.length} previewed</>}
        </div>
        <div className="text-xs text-ink-light">Window: 2026-01-01 → today</div>
      </div>

      <div className="rounded-xl border border-cardline bg-white overflow-hidden divide-y divide-hairline">
        {clients.length === 0 && (
          <div className="px-4 py-6 text-sm text-ink-slate">No Canadian clients with a QuickBooks connection.</div>
        )}
        {clients.map((c) => {
          const pv = previews[c.id];
          const hasPv = pv && !("error" in pv);
          const p = hasPv ? (pv as Preview) : null;
          const isOpen = expanded.has(c.id);
          const res = results[c.id];
          const busy = running === c.id;
          const ex = excluded[c.id] || new Set<string>();

          return (
            <div key={c.id}>
              {/* Row */}
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <button onClick={() => toggle(c.id)} className="flex items-center gap-2 min-w-0 text-left">
                  {isOpen ? <ChevronDown size={14} className="text-ink-light" /> : <ChevronRight size={14} className="text-ink-light" />}
                  <span className="text-sm font-semibold text-navy truncate">{c.client_name}</span>
                  <span className="font-brand text-[10px] uppercase tracking-[0.1em] text-ink-light flex-shrink-0">
                    {c.province || "—"}
                  </span>
                  {c.live && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-teal-light text-teal-dark flex-shrink-0">LIVE</span>
                  )}
                  {!c.gst_number && (
                    <span className="text-[10px] text-gold-deep flex-shrink-0" title="No GST number on file (informational — extraction still runs)">
                      no GST #
                    </span>
                  )}
                  {p && (
                    <span className="text-[11px] text-ink-slate flex-shrink-0 tabular-nums">
                      · {money(p.totals?.gstHstCollected)} tax · {money(p.totals?.itcTotal)} ITCs
                    </span>
                  )}
                  {pv && "error" in pv && (
                    <span className="text-[11px] text-rust flex-shrink-0">{(pv as any).error}</span>
                  )}
                </button>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Link href={`/clients/${c.id}`} className="text-ink-light hover:text-navy" title="Open client">
                    <ExternalLink size={14} />
                  </Link>
                  <button
                    onClick={() => preview(c.id)}
                    disabled={previewing === c.id || busy}
                    className="inline-flex items-center gap-1 rounded-lg border border-cardline px-2.5 py-1 text-xs font-semibold text-ink-slate hover:text-navy hover:border-teal disabled:opacity-50"
                  >
                    {previewing === c.id ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                    {pv ? "Re-preview" : "Preview"}
                  </button>
                </div>
              </div>

              {/* Detail */}
              {isOpen && p && (
                <div className="px-4 pb-4 space-y-4 bg-canvas/40">
                  {/* Planned totals */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Stat label="Revenue in scope" value={money(p.totals?.incomeGross)} sub={`${p.deposit_count} deposit lines`} />
                    <Stat label="Sales tax to extract" value={money(p.totals?.gstHstCollected)} sub="→ GST/HST Payable" accent />
                    <Stat label="Expenses in scope" value={money(p.totals?.expenseGross)} sub={`${p.expense_count} expense lines`} />
                    <Stat label="ITCs to extract" value={money(p.totals?.itcTotal)} sub="→ GST/HST Recoverable" accent />
                  </div>
                  {(p.totals?.pstCollected || 0) > 0 && (
                    <div className="text-xs text-ink-slate">
                      Plus <strong className="text-navy">{money(p.totals?.pstCollected)}</strong> PST on revenue → PST Payable
                      ({p.province} charges PST on these services).
                    </div>
                  )}
                  {p.capped && (
                    <div className="text-xs text-gold-deep">
                      Preview list truncated for display — apply still processes the full window.
                    </div>
                  )}

                  {/* Accounts the planner refuses to guess — no ITC claimed on
                      these until someone classifies them on the master COA. */}
                  {p.skipped?.unknownAccounts && p.skipped.unknownAccounts.length > 0 && (
                    <div className="rounded-lg border border-gold-border bg-gold-tint px-3 py-2 text-xs text-gold-deep">
                      <strong>{p.skipped.unknownAccounts.length} account{p.skipped.unknownAccounts.length === 1 ? "" : "s"} skipped
                      — couldn&apos;t be classified,</strong> so no ITC is claimed on them (deliberately never guessed):{" "}
                      {p.skipped.unknownAccounts.slice(0, 12).join(", ")}
                      {p.skipped.unknownAccounts.length > 12 && ` +${p.skipped.unknownAccounts.length - 12} more`}.
                    </div>
                  )}

                  {/* Off-master accounts classified by name — the review list */}
                  {p.heuristic_kinds && p.heuristic_kinds.length > 0 && (
                    <details className="rounded-lg border border-cardline bg-white px-3 py-2">
                      <summary className="text-xs font-semibold text-navy cursor-pointer">
                        {p.heuristic_kinds.length} account{p.heuristic_kinds.length === 1 ? "" : "s"} classified by name
                        (not on the master COA) — worth a skim
                      </summary>
                      <div className="mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1">
                        {p.heuristic_kinds.map((h, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <span className="text-ink-slate truncate">{h.account}</span>
                            <span className={`font-semibold flex-shrink-0 ml-2 ${h.kind === "none" ? "text-ink-light" : "text-teal-dark"}`}>
                              {h.kind}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Vendor ITC review — exclude unregistered suppliers */}
                  {p.vendor_itc_summary && p.vendor_itc_summary.length > 0 && (
                    <details className="rounded-lg border border-cardline bg-white px-3 py-2">
                      <summary className="text-xs font-semibold text-navy cursor-pointer">
                        ITCs by vendor — tick any that aren&apos;t GST-registered to exclude them
                        {ex.size > 0 && <span className="text-rust font-bold"> ({ex.size} excluded)</span>}
                      </summary>
                      <p className="text-[11px] text-ink-light mt-1.5">
                        A supplier who isn&apos;t registered can&apos;t charge GST, so there&apos;s no ITC to claim on
                        their invoices. Person-named vendors are the usual suspects. Re-preview after ticking to see the
                        adjusted total.
                      </p>
                      <div className="mt-2 max-h-64 overflow-y-auto divide-y divide-hairline">
                        {p.vendor_itc_summary.map((v) => (
                          <label key={v.vendor} className="flex items-center gap-2 py-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={ex.has(v.vendor)}
                              onChange={() => toggleVendor(c.id, v.vendor)}
                              className="rounded border-cardline text-teal focus:ring-teal"
                            />
                            <span className={`text-xs flex-1 min-w-0 truncate ${ex.has(v.vendor) ? "text-ink-light line-through" : "text-ink"}`}>
                              {v.vendor}
                            </span>
                            <span className="text-xs text-ink-slate tabular-nums flex-shrink-0">
                              {money(v.itc)} · {v.lines} line{v.lines === 1 ? "" : "s"}
                            </span>
                          </label>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <ActionBtn onClick={() => apply(c.id, "income", true)} disabled={busy} kind="dry">
                      Dry run income
                    </ActionBtn>
                    <ActionBtn onClick={() => apply(c.id, "income", false)} disabled={busy} kind="live">
                      Apply income
                    </ActionBtn>
                    <span className="w-2" />
                    <ActionBtn onClick={() => apply(c.id, "expenses", true)} disabled={busy} kind="dry">
                      Dry run expenses
                    </ActionBtn>
                    <ActionBtn onClick={() => apply(c.id, "expenses", false)} disabled={busy} kind="live">
                      Apply expenses
                    </ActionBtn>
                    {busy && <Loader2 size={14} className="animate-spin text-teal-dark" />}
                  </div>

                  {progress[c.id] && (
                    <div className={`text-xs font-medium ${progress[c.id].startsWith("Error") ? "text-rust" : "text-teal-dark"}`}>
                      {progress[c.id]}
                    </div>
                  )}

                  {/* Result of the last run */}
                  {res && (
                    <div className="rounded-lg border border-cardline bg-white px-3 py-2 text-xs space-y-1">
                      <div className="font-semibold text-navy flex items-center gap-1.5">
                        {res.dry_run ? <Eye size={12} /> : <CheckCircle2 size={12} className="text-teal-dark" />}
                        {res.dry_run ? "Dry run" : "Applied"} · {res.side}
                        {res.done && !res.dry_run && <span className="text-teal-dark">· complete</span>}
                      </div>
                      <Line k="Revenue transactions" v={res.deposits} dry={res.dry_run} />
                      <Line k="Expense transactions" v={res.expenses} dry={res.dry_run} />
                      {res.accounts?.created && res.accounts.created.length > 0 && (
                        <div className="text-ink-slate">
                          Accounts created: <strong className="text-navy">{res.accounts.created.join(", ")}</strong>
                        </div>
                      )}
                      {res.remaining > 0 && (
                        <div className="text-gold-deep">{res.remaining} transaction(s) still queued — click Apply again.</div>
                      )}
                      {res.failures && res.failures.length > 0 && (
                        <details>
                          <summary className="text-rust font-semibold cursor-pointer">
                            {res.failures.length} problem{res.failures.length === 1 ? "" : "s"} — details
                          </summary>
                          <ul className="mt-1 space-y-0.5 text-rust">
                            {res.failures.map((f, i) => (
                              <li key={i} className="truncate">
                                {f.txnType || f.txn_type} {f.txnId || f.txn_id}: {f.error || f.outcome}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-gold-border bg-gold-tint px-4 py-3 text-xs text-gold-deep">
        <div className="font-semibold flex items-center gap-1.5">
          <AlertTriangle size={14} /> Before running the whole fleet
        </div>
        <p className="mt-1">
          Validate on one or two clients first and check the resulting balance sheet in QuickBooks. In BC, SK and MB the
          expense ITC depends on whether PST applied to that purchase — the rules are encoded per category, but a
          receipt-level check on a few expense lines is worth doing on the first client.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${accent ? "border-teal-border bg-teal-lighter" : "border-cardline bg-white"}`}>
      <div className="font-brand text-[10px] uppercase tracking-[0.1em] text-ink-light">{label}</div>
      <div className={`text-base font-bold tabular-nums mt-1 ${accent ? "text-teal-dark" : "text-navy"}`}>{value}</div>
      <div className="text-[11px] text-ink-slate mt-0.5">{sub}</div>
    </div>
  );
}

function Line({ k, v, dry }: { k: string; v: ApplySummary["deposits"]; dry: boolean }) {
  if (!v || !v.planned_txns) return null;
  return (
    <div className="text-ink-slate">
      {k}: <strong className="text-navy">{dry ? v.would_split : v.split}</strong> {dry ? "would split" : "split"}
      {v.skipped_already > 0 && <> · {v.skipped_already} already done</>}
      {v.skipped_closed > 0 && <> · {v.skipped_closed} in a closed period</>}
      {v.skipped_stale > 0 && <> · <span className="text-rust">{v.skipped_stale} changed since preview</span></>}
      {v.failed > 0 && <> · <span className="text-rust">{v.failed} failed</span></>}
    </div>
  );
}

function ActionBtn({
  onClick, disabled, kind, children,
}: { onClick: () => void; disabled?: boolean; kind: "dry" | "live"; children: React.ReactNode }) {
  const cls = kind === "live"
    ? "border-rust-border bg-white text-rust hover:bg-rust-tint"
    : "border-cardline bg-white text-ink-slate hover:text-navy hover:border-teal";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${cls}`}
    >
      {kind === "live" ? <Play size={12} /> : <Eye size={12} />}
      {children}
    </button>
  );
}
