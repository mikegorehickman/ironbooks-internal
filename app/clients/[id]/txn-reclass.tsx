"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Search, Sparkles, X } from "lucide-react";

/**
 * Transaction reclass from the statement drill-down (bookkeeper view).
 *
 * Two pieces:
 *  - ReclassBar        the action bar: pick a target account (MASTER COA first,
 *                      with an escape hatch to the full QBO chart) and move the
 *                      selected transactions. Budget-chunked via `remaining`.
 *  - SimilarTxnsPicker "…and all the other ones like it": finds same-vendor
 *                      transactions in the SAME account over the drilled period
 *                      or the whole year, and lets the bookkeeper check off
 *                      exactly which ones to include.
 *
 * Why master COA first: after cleanup the master chart is the only COA the team
 * should be categorizing into, but the raw QBO list still contains legacy /
 * off-master accounts. Defaulting the picker to master-matching accounts keeps
 * reclass from re-introducing sprawl, while "Show all" stays available for the
 * genuine one-offs (banks, loans, clearing accounts).
 */

export type ReclassTxn = {
  id: string;
  type: string;
  date?: string;
  name?: string | null;
  memo?: string;
  amount?: number;
};

type QboAccountOption = {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
  classification: string;
  /** Name matches a leaf in the master COA for this client's jurisdiction. */
  isMaster?: boolean;
};

/** Mirrors lib/account-name.ts normalizeAccountName (kept local — that module
 *  is server-side and we don't want it in the client bundle). */
function normAccountName(name: string | null | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/\s*\(deleted\)\s*$/i, "")
    .trim();
}

/** Mirrors lib/qbo-reclass.ts normalizeVendorName — groups "SHERWIN-WILLIAMS
 *  #4521" and "Sherwin Williams Co" onto one key so "similar" means the same
 *  merchant regardless of store number or suffix. */
export function vendorKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[#\-_*/\\.,]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(CO|INC|LLC|LTD|CORP|COMPANY|THE|STORE|\d+)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const txnKeyOf = (t: { type: string; id: string }) => `${t.type}::${t.id}`;

const isPL = (a: QboAccountOption) =>
  ["Revenue", "Income", "Expense", "Other Income", "Other Expense", "Cost of Goods Sold"].some(
    (c) => a.classification === c || a.accountType.includes(c)
  );

export function ReclassBar({
  clientLinkId,
  jurisdiction,
  sourceAccountId,
  sourceAccountName,
  kind,
  start,
  end,
  selectedTxns,
  onApplied,
  onAddSimilar,
}: {
  clientLinkId: string;
  jurisdiction: string | null;
  sourceAccountId: string;
  sourceAccountName: string;
  kind: "pl" | "bs";
  start: string;
  end: string;
  selectedTxns: ReclassTxn[];
  onApplied: () => void;
  /** Merge additional (possibly out-of-view) transactions into the selection. */
  onAddSimilar: (txns: ReclassTxn[]) => void;
}) {
  const [accounts, setAccounts] = useState<QboAccountOption[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [masterOnly, setMasterOnly] = useState(true);
  const [target, setTarget] = useState<QboAccountOption | null>(null);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createRule, setCreateRule] = useState(true);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [failures, setFailures] = useState<Array<{ id: string; type: string; blocked: string | null; message: string }>>([]);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [similarOpen, setSimilarOpen] = useState(false);

  const selectedCount = selectedTxns.length;

  // Load the client's QBO chart + the master COA, and flag which QBO accounts
  // correspond to a master leaf.
  useEffect(() => {
    if (accounts !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const [qboRes, masterRes] = await Promise.all([
          fetch(`/api/clients/${clientLinkId}/qbo-accounts`),
          fetch(`/api/master-coa?jurisdiction=${jurisdiction === "CA" ? "CA" : "US"}`).catch(() => null),
        ]);
        if (!qboRes.ok) throw new Error((await qboRes.json()).error || `Fetch failed (${qboRes.status})`);
        const qbo = await qboRes.json();
        let masterNames = new Set<string>();
        if (masterRes && masterRes.ok) {
          const m = await masterRes.json();
          masterNames = new Set(
            ((m.accounts as any[]) || [])
              .filter((r) => !r.is_parent)
              .map((r) => normAccountName(r.account_name))
              .filter(Boolean)
          );
        }
        const list: QboAccountOption[] = ((qbo.accounts as any[]) || []).map((a) => {
          const leaf = String(a.fullyQualifiedName || a.name || "").split(":").pop() || "";
          return {
            ...a,
            isMaster: masterNames.has(normAccountName(a.name)) || masterNames.has(normAccountName(leaf)),
          };
        });
        if (cancelled) return;
        setAccounts(list);
        // No master matches (e.g. chart not standardized yet) → don't trap the
        // bookkeeper behind an empty picker.
        if (!list.some((a) => a.isMaster)) setMasterOnly(false);
      } catch (e: any) {
        if (!cancelled) setAccountsError(e?.message || "Could not load accounts");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientLinkId, jurisdiction, accounts]);

  const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = norm(search).split(" ").filter(Boolean);
  const masterCount = (accounts || []).filter((a) => a.isMaster).length;
  const filtered = (accounts || [])
    .filter((a) => a.id !== sourceAccountId)
    .filter((a) => (masterOnly ? a.isMaster : true))
    .filter((a) => {
      if (tokens.length === 0) return true;
      const hay = norm(`${a.fullyQualifiedName} ${a.accountType} ${a.classification}`);
      return tokens.every((t) => hay.includes(t));
    })
    .slice(0, 80);

  async function apply() {
    if (!target) return;
    setApplying(true);
    setApplyError(null);
    setResult(null);
    setFailures([]);
    const totals: Record<string, number> = {
      moved_txns: 0, moved_lines: 0, skipped_unsupported: 0, skipped_closed: 0,
      skipped_stale: 0, skipped_no_source_line: 0, skipped_linked: 0, failed: 0,
      rules_created: 0, rules_updated: 0,
    };
    const collectedFailures: Array<{ id: string; type: string; blocked: string | null; message: string }> = [];
    let queue: Array<{ id: string; type: string }> = selectedTxns.map((t) => ({ id: t.id, type: t.type }));
    const initial = queue.length;
    try {
      for (let pass = 0; pass < 25; pass++) {
        const res = await fetch(`/api/clients/${clientLinkId}/bulk-reclass`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_account_id: sourceAccountId,
            source_account_name: sourceAccountName,
            target_account_id: target.id,
            transactions: queue,
            create_rules: createRule,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        for (const k of Object.keys(totals)) totals[k] += d[k] || 0;
        if (Array.isArray(d.failures)) collectedFailures.push(...d.failures);
        if (!d.remaining?.length) break;
        queue = d.remaining;
        setProgress(`${initial - queue.length} of ${initial} processed…`);
      }
      setResult(totals);
      setFailures(collectedFailures);
      setProgress(null);
      onApplied();
    } catch (e: any) {
      setApplyError(e?.message || "Reclass failed");
    } finally {
      setApplying(false);
    }
  }

  if (result) {
    const moved = result.moved_txns > 0;
    const parts: string[] = [`${result.moved_txns} moved`];
    if (result.rules_created) parts.push(`${result.rules_created} rule${result.rules_created === 1 ? "" : "s"} created`);
    if (result.rules_updated) parts.push(`${result.rules_updated} rule${result.rules_updated === 1 ? "" : "s"} updated`);
    if (result.skipped_closed) parts.push(`${result.skipped_closed} in a closed period`);
    if (result.skipped_stale) parts.push(`${result.skipped_stale} changed since (kept)`);
    if (result.skipped_linked) parts.push(`${result.skipped_linked} linked deposit${result.skipped_linked === 1 ? "" : "s"}`);
    if (result.skipped_unsupported) parts.push(`${result.skipped_unsupported} not movable here`);
    if (result.skipped_no_source_line) parts.push(`${result.skipped_no_source_line} already moved`);
    if (result.failed) parts.push(`${result.failed} failed`);
    // Celebrate a real move; stay neutral (amber) when nothing actually moved so
    // "0 moved" can never read as success.
    const tone = moved
      ? { box: "bg-emerald-50", icon: "text-emerald-600", head: "text-emerald-900", body: "text-emerald-800" }
      : { box: "bg-amber-50", icon: "text-amber-600", head: "text-amber-900", body: "text-amber-800" };
    const Icon = moved ? CheckCircle2 : AlertCircle;
    return (
      <div className={`border-t border-gray-200 px-5 py-3 ${tone.box}`}>
        <div className="flex items-start gap-2 text-xs">
          <Icon size={15} className={`${tone.icon} shrink-0 mt-0.5`} />
          <div className={tone.head}>
            <span className="font-bold">
              {moved
                ? `Reclass complete — ${parts.join(" · ")}.`
                : `Nothing moved — ${parts.join(" · ")}.`}
            </span>
            {moved && (
              <div className={`mt-1 ${tone.body}`}>
                Moved into <span className="font-semibold">{target?.name || "the target account"}</span>. The P&amp;L reflects it immediately.
              </div>
            )}
            {result.skipped_closed > 0 && (
              <div className={`mt-1 ${tone.body}`}>
                Transactions in a closed period were left alone — reopen the month in QuickBooks to move those.
              </div>
            )}
            {result.skipped_linked > 0 && (
              <div className={`mt-1 ${tone.body}`}>
                Some deposits are linked to a customer payment or sales receipt — those move when you recategorize the
                linked transaction (or apply/void the payment), not the deposit itself.
              </div>
            )}
            {result.skipped_unsupported > 0 && (
              <div className={`mt-1 ${tone.body}`}>
                Transfers and journal entries can&apos;t be moved from this tool — open them in QuickBooks. (Deposits now
                move here.)
              </div>
            )}
            {failures.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {Object.entries(
                  failures.reduce<Record<string, number>>((m, f) => { m[f.message] = (m[f.message] || 0) + 1; return m; }, {})
                ).map(([msg, count]) => (
                  <div key={msg} className="text-[11px] text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                    <span className="font-bold">{count} couldn&apos;t move:</span> {msg}
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => { setResult(null); setFailures([]); }} className="mt-1.5 text-teal font-semibold hover:underline">
              Reclass more
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 px-5 py-3 bg-teal-lighter/30">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-xs font-bold text-navy">
          <ArrowRight size={14} className="text-teal" />
          Reclass {selectedCount} transaction{selectedCount === 1 ? "" : "s"}
        </div>
        <button
          onClick={() => setSimilarOpen(true)}
          disabled={applying}
          className="inline-flex items-center gap-1.5 text-[11px] font-bold text-teal border border-teal/40 rounded-lg px-2 py-1 hover:bg-teal/5 disabled:opacity-50"
          title="Find the same vendor's other transactions over this period or the whole year"
        >
          <Sparkles size={12} /> Find similar
        </button>
      </div>

      {/* Target account picker — master COA by default */}
      <div className="relative mb-1.5">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-light pointer-events-none" />
          <input
            type="text"
            value={pickerOpen ? search : target ? target.name : ""}
            onChange={(e) => { setSearch(e.target.value); setPickerOpen(true); }}
            onFocus={() => setPickerOpen(true)}
            placeholder={
              accountsError ||
              (accounts === null ? "Loading accounts…" : masterOnly ? "Search the master chart of accounts…" : "Search all QuickBooks accounts…")
            }
            disabled={accounts === null || !!accountsError || applying}
            className="w-full text-xs border border-gray-300 rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
        </div>
        {pickerOpen && accounts && (
          <div className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg z-20">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-ink-slate">
                No matching accounts{masterOnly ? " in the master chart" : ""}.
              </div>
            ) : (
              filtered.map((a) => (
                <button
                  key={a.id}
                  onClick={() => { setTarget(a); setPickerOpen(false); setSearch(""); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-teal-lighter/40 flex items-center justify-between gap-2"
                >
                  <span className="truncate text-navy">{a.fullyQualifiedName}</span>
                  <span className="shrink-0 flex items-center gap-1.5">
                    {a.isMaster && (
                      <span className="text-[9px] font-bold uppercase text-teal bg-teal-lighter px-1 py-0.5 rounded">Master</span>
                    )}
                    <span className="text-[10px] font-bold uppercase text-ink-slate">{isPL(a) ? "P&L" : "BS"}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {accounts && masterCount > 0 && (
        <button
          onClick={() => { setMasterOnly((v) => !v); setPickerOpen(true); }}
          className="mb-2 text-[11px] font-semibold text-teal hover:underline"
        >
          {masterOnly ? "Show all QuickBooks accounts" : `Show master chart only (${masterCount})`}
        </button>
      )}

      <label className="flex items-start gap-2 mb-2 text-xs text-navy cursor-pointer">
        <input
          type="checkbox"
          checked={createRule}
          onChange={(e) => setCreateRule(e.target.checked)}
          disabled={applying}
          className="mt-0.5 accent-teal"
        />
        <span>
          Create a rule so these vendors auto-categorize to{" "}
          <span className="font-semibold">{target ? target.name : "the new account"}</span> next time
        </span>
      </label>

      {applyError && (
        <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">{applyError}</div>
      )}

      <button
        onClick={apply}
        disabled={!target || applying}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-teal text-white text-xs font-bold hover:bg-teal-dark disabled:opacity-50"
      >
        {applying ? (
          <><Loader2 size={13} className="animate-spin" /> {progress || "Moving…"}</>
        ) : (
          <><ArrowRight size={13} /> Move {selectedCount} to {target ? target.name : "…"}</>
        )}
      </button>

      {similarOpen && (
        <SimilarTxnsPicker
          clientLinkId={clientLinkId}
          accountId={sourceAccountId}
          accountName={sourceAccountName}
          kind={kind}
          start={start}
          end={end}
          basis={selectedTxns}
          alreadySelected={new Set(selectedTxns.map(txnKeyOf))}
          onClose={() => setSimilarOpen(false)}
          onAdd={(txns) => { onAddSimilar(txns); setSimilarOpen(false); }}
        />
      )}
    </div>
  );
}

/**
 * Find same-vendor transactions in this account over a wider window and let the
 * bookkeeper check off exactly which to include. Reuses the drill endpoint, so
 * "the year" is the same data path the drawer already trusts.
 */
function SimilarTxnsPicker({
  clientLinkId, accountId, accountName, kind, start, end, basis, alreadySelected, onClose, onAdd,
}: {
  clientLinkId: string;
  accountId: string;
  accountName: string;
  kind: "pl" | "bs";
  start: string;
  end: string;
  basis: ReclassTxn[];
  alreadySelected: Set<string>;
  onClose: () => void;
  onAdd: (txns: ReclassTxn[]) => void;
}) {
  const year = (end || start || "").slice(0, 4);
  const [scope, setScope] = useState<"period" | "year">("period");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<ReclassTxn[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Vendor keys from the transactions the bookkeeper already selected.
  const basisKeys = useMemo(() => {
    const s = new Set<string>();
    for (const t of basis) {
      const k = vendorKey(t.name);
      if (k) s.add(k);
    }
    return s;
  }, [basis]);
  const basisLabel = basis
    .map((t) => (t.name || "").trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3)
    .join(", ");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFound(null);
    const s = scope === "year" ? `${year}-01-01` : start;
    const e = scope === "year" ? `${year}-12-31` : end;
    fetch(`/api/clients/${clientLinkId}/account-transactions?account_id=${encodeURIComponent(accountId)}&start=${s}&end=${e}&kind=${kind}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `Fetch failed (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setTruncated(!!d.truncated);
        const seen = new Set<string>();
        const matches: ReclassTxn[] = [];
        for (const t of (d.transactions || []) as ReclassTxn[]) {
          const k = txnKeyOf(t as any);
          if (seen.has(k) || alreadySelected.has(k)) continue; // de-dup split lines + already-chosen
          if (basisKeys.size > 0 && !basisKeys.has(vendorKey(t.name))) continue;
          seen.add(k);
          matches.push({ id: t.id, type: t.type, date: t.date, name: t.name, memo: t.memo, amount: t.amount });
        }
        setFound(matches);
        setPicked(new Set(matches.map((m) => txnKeyOf(m as any)))); // default: all checked
      })
      .catch((e2) => { if (!cancelled) setError(e2?.message || "Failed to search"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clientLinkId, accountId, kind, start, end, scope, year, basisKeys, alreadySelected]);

  const toggle = (k: string) =>
    setPicked((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allPicked = !!found && found.length > 0 && picked.size === found.length;

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-navy">Find similar transactions</h3>
            <p className="text-[11px] text-ink-slate mt-0.5 truncate">
              Same vendor{basisLabel ? ` as ${basisLabel}` : ""} in <span className="font-semibold">{accountName}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-ink-light hover:text-navy shrink-0"><X size={16} /></button>
        </div>

        <div className="px-5 py-2.5 border-b border-gray-100 flex items-center gap-1.5">
          {([["period", `This period (${start} → ${end})`], ["year", `All of ${year}`]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setScope(k)}
              className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border ${
                scope === k ? "border-teal bg-teal-lighter text-teal-dark" : "border-gray-200 text-ink-slate hover:border-gray-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="px-5 py-10 text-center text-xs text-ink-slate">
              <Loader2 size={14} className="animate-spin inline mr-1.5" /> Searching…
            </div>
          ) : error ? (
            <div className="m-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">{error}</div>
          ) : !found || found.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-ink-slate">
              No other transactions from {basisLabel || "this vendor"} in this range.
            </div>
          ) : (
            <>
              <label className="flex items-center gap-3 px-5 py-2 text-xs bg-gray-50 sticky top-0 border-b border-gray-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(found.map((m) => txnKeyOf(m as any))))}
                  className="accent-teal"
                />
                <span className="font-semibold text-ink-slate">
                  {picked.size} of {found.length} selected
                </span>
              </label>
              <div className="divide-y divide-gray-100">
                {found.map((t) => {
                  const k = txnKeyOf(t as any);
                  return (
                    <label key={k} className="flex items-start gap-3 px-5 py-2 text-xs hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} className="mt-0.5 accent-teal" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-ink-slate shrink-0">{t.date}</span>
                          <span className={`font-mono font-bold shrink-0 ${(t.amount ?? 0) < 0 ? "text-red-600" : "text-navy"}`}>
                            {`${(t.amount ?? 0) < 0 ? "-" : ""}$${Math.abs(t.amount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                          </span>
                        </div>
                        <div className="text-navy truncate">
                          {t.name && <span className="font-semibold">{t.name}</span>}
                          {t.name && t.memo && <span className="text-ink-slate"> · </span>}
                          {t.memo && <span className="text-ink-slate">{t.memo}</span>}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
              {truncated && (
                <div className="px-5 py-2 text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200">
                  The account has more than 500 transactions in this range — results may be incomplete.
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2">
          <button
            onClick={() => onAdd((found || []).filter((m) => picked.has(txnKeyOf(m as any))))}
            disabled={picked.size === 0}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3.5 py-2 rounded-lg disabled:opacity-50"
          >
            <CheckCircle2 size={13} /> Add {picked.size} to the reclass
          </button>
          <button onClick={onClose} className="text-xs font-semibold border border-gray-200 px-3 py-2 rounded-lg hover:border-gray-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
