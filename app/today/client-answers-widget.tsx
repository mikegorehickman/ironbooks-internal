"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, Loader2, MessageCircleQuestion, Sparkles, X, ListChecks } from "lucide-react";
import type { ClientAnswerRow } from "@/lib/client-answers";

/**
 * Client answers — ask-client transaction questions the client has answered.
 *
 * Per-row: one-click Approve (applies their pick to QBO); a dropdown with
 * AI-suggested similar accounts + the full chart; Reject.
 *
 * Bulk (per client): tick rows → a toolbar appears with Approve selected,
 * Approve + add rule, Reject selected, and Apply-one-account-to-all. Ticking
 * a single row auto-selects every "matching" row (same source account + same
 * client answer) so identical entries (e.g. 80 card transfers) go in one pass.
 * Nothing is applied until you click an action — a broad match can't misfire.
 */

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();
/** Two rows "match" when source + the client's answer are identical. */
const matchKey = (r: ClientAnswerRow) =>
  `${norm(r.from_account)}␟${norm(r.answer_account)}␟${norm(r.answer_note)}`;

type CoaAccount = { id: string; name: string; type: string; section: string };

export function ClientAnswersWidget({ rows: initial }: { rows: ClientAnswerRow[] }) {
  const [rows, setRows] = useState(initial);
  // Home shows the first 5 client groups; toggle for the rest.
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ label: string; done: number; total: number } | null>(null);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);

  const byClient = useMemo(() => {
    const m = new Map<string, ClientAnswerRow[]>();
    for (const r of rows) {
      const arr = m.get(r.client_name) || [];
      arr.push(r);
      m.set(r.client_name, arr);
    }
    return m;
  }, [rows]);

  function dropRows(ids: string[]) {
    const idSet = new Set(ids);
    setRows((p) => p.filter((x) => !idSet.has(x.id)));
    setSelected((p) => {
      const n = new Set(p);
      ids.forEach((id) => n.delete(id));
      return n;
    });
  }

  // Tick one row → toggle it + every matching row in the same client group.
  function toggleRow(row: ClientAnswerRow, clientRows: ClientAnswerRow[]) {
    const key = matchKey(row);
    const group = clientRows.filter((r) => matchKey(r) === key).map((r) => r.id);
    setSelected((prev) => {
      const n = new Set(prev);
      const turningOn = !prev.has(row.id);
      group.forEach((id) => (turningOn ? n.add(id) : n.delete(id)));
      return n;
    });
  }

  function setClientSelection(clientRows: ClientAnswerRow[], on: boolean) {
    setSelected((prev) => {
      const n = new Set(prev);
      clientRows.forEach((r) => (on ? n.add(r.id) : n.delete(r.id)));
      return n;
    });
  }

  // Sequentially run an action over a set of rows (QBO rate limits + per-row
  // live guards — same pattern the single-client "Approve all" already used).
  async function runBulk(
    label: string,
    targets: ClientAnswerRow[],
    bodyFor: (r: ClientAnswerRow) => any
  ): Promise<ClientAnswerRow[]> {
    const succeeded: ClientAnswerRow[] = [];
    const errs: string[] = [];
    setBulk({ label, done: 0, total: targets.length });
    setBulkErrors([]);
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      try {
        const res = await fetch(`/api/today/client-answers/${r.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyFor(r)),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        succeeded.push(r);
      } catch (e: any) {
        errs.push(`${r.vendor || r.description || r.id}: ${e?.message || "failed"}`);
      }
      setBulk({ label, done: i + 1, total: targets.length });
    }
    if (succeeded.length) dropRows(succeeded.map((r) => r.id));
    setBulkErrors(errs);
    setBulk(null);
    return succeeded;
  }

  // Approve, then create vendor→account bank rules via the existing builder,
  // grouped by reclass job (rules are keyed off the reclass rows' vendors).
  async function approveAndAddRule(targets: ClientAnswerRow[], overrideAccount?: { id: string; name: string }) {
    const withAccount = targets.filter((r) => overrideAccount || r.answer_account);
    const done = await runBulk(
      "Approving + building rules",
      withAccount,
      overrideAccount
        ? (r) => ({ action: "approve_as", account_id: overrideAccount.id, account_name: overrideAccount.name })
        : () => ({ action: "approve" })
    );
    // Group succeeded rows by (reclass_job_id, client_link_id) → vendor list.
    const byJob = new Map<string, { jobId: string; clientId: string; vendors: Set<string> }>();
    for (const r of done) {
      // from-reclass groups by vendor_pattern_normalized || vendor_name, so
      // pass that same key (falls back to the display vendor).
      const vendorKey = r.vendor_pattern || r.vendor;
      if (!vendorKey) continue;
      const k = `${r.reclass_job_id}|${r.client_link_id}`;
      if (!byJob.has(k)) byJob.set(k, { jobId: r.reclass_job_id, clientId: r.client_link_id, vendors: new Set() });
      byJob.get(k)!.vendors.add(vendorKey);
    }
    for (const g of byJob.values()) {
      try {
        await fetch("/api/rules/from-reclass", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reclass_job_id: g.jobId,
            client_link_id: g.clientId,
            selected_vendors: [...g.vendors],
            ...(overrideAccount ? { overrides: Object.fromEntries([...g.vendors].map((v) => [v, overrideAccount])) } : {}),
          }),
        });
      } catch {
        /* rule creation is best-effort; approvals already applied */
      }
    }
  }

  if (rows.length === 0 && bulkErrors.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
        <MessageCircleQuestion size={15} className="text-teal" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Client answers ({rows.length})</h2>
        <span className="text-[11px] text-ink-light">
          the client answered a transaction question — tick to bulk-approve, or confirm one at a time
        </span>
      </div>
      <div className="divide-y divide-gray-50">
        {bulkErrors.length > 0 && (
          <div className="px-5 py-2 text-xs text-red-800 bg-red-50 border-b border-red-100">
            {bulkErrors.length} failed (still listed below): {bulkErrors.slice(0, 3).join(" · ")}
            {bulkErrors.length > 3 ? "…" : ""}
          </div>
        )}
        {(showAll ? [...byClient.entries()] : [...byClient.entries()].slice(0, 5)).map(([client, list]) => {
          const selectedRows = list.filter((r) => selected.has(r.id));
          return (
            <ClientGroup
              key={client}
              client={client}
              list={list}
              selectedIds={selected}
              selectedRows={selectedRows}
              bulk={bulk}
              onToggleRow={(r) => toggleRow(r, list)}
              onSelectAll={(on) => setClientSelection(list, on)}
              onApprove={() =>
                runBulk("Approving", selectedRows.filter((r) => r.answer_account), () => ({ action: "approve" }))
              }
              onApproveAddRule={() => approveAndAddRule(selectedRows)}
              onReject={() => runBulk("Rejecting", selectedRows, () => ({ action: "reject" }))}
              onApplyAccount={(acc, alsoRule) =>
                alsoRule
                  ? approveAndAddRule(selectedRows, acc)
                  : runBulk("Applying account", selectedRows, () => ({ action: "approve_as", account_id: acc.id, account_name: acc.name }))
              }
              onRowDone={(id) => dropRows([id])}
            />
          );
        })}
      </div>
      {byClient.size > 5 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full px-5 py-2.5 text-left text-xs font-semibold text-teal-dark hover:text-navy border-t border-hairline transition-colors"
        >
          {showAll ? "Show top 5 clients" : `Show all ${byClient.size} clients (${rows.length} answers)`}
        </button>
      )}
    </div>
  );
}

function ClientGroup({
  client, list, selectedIds, selectedRows, bulk, onToggleRow, onSelectAll,
  onApprove, onApproveAddRule, onReject, onApplyAccount, onRowDone,
}: {
  client: string;
  list: ClientAnswerRow[];
  selectedIds: Set<string>;
  selectedRows: ClientAnswerRow[];
  bulk: { label: string; done: number; total: number } | null;
  onToggleRow: (r: ClientAnswerRow) => void;
  onSelectAll: (on: boolean) => void;
  onApprove: () => void;
  onApproveAddRule: () => void;
  onReject: () => void;
  onApplyAccount: (acc: { id: string; name: string }, alsoRule: boolean) => void;
  onRowDone: (id: string) => void;
}) {
  const allSelected = list.length > 0 && list.every((r) => selectedIds.has(r.id));
  const n = selectedRows.length;
  const approvable = selectedRows.filter((r) => r.answer_account).length;
  const [picker, setPicker] = useState(false);

  return (
    <div>
      <div className="px-5 pt-3 pb-1 flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => onSelectAll(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-gray-300 text-teal focus:ring-teal"
          />
          <span className="text-xs font-bold text-ink-slate">{client}</span>
        </label>

        {n > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-semibold text-navy bg-teal-lighter border border-teal-light rounded-full px-2 py-0.5">
              {n} selected
            </span>
            {bulk ? (
              <span className="text-[11px] text-ink-slate inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> {bulk.label} {bulk.done}/{bulk.total}…
              </span>
            ) : (
              <>
                <BulkBtn onClick={onApprove} disabled={approvable === 0} icon={<CheckCircle2 size={11} />}>
                  Approve {approvable}
                </BulkBtn>
                <BulkBtn onClick={onApproveAddRule} disabled={approvable === 0} icon={<ListChecks size={11} />}>
                  Approve + add rule
                </BulkBtn>
                <div className="relative">
                  <BulkBtn onClick={() => setPicker((v) => !v)} icon={<ChevronDown size={11} />}>
                    Apply account…
                  </BulkBtn>
                  {picker && (
                    <AccountPicker
                      sampleRowId={selectedRows[0]?.id}
                      onClose={() => setPicker(false)}
                      onPick={(acc, alsoRule) => { setPicker(false); onApplyAccount(acc, alsoRule); }}
                    />
                  )}
                </div>
                <button
                  onClick={onReject}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-slate hover:text-red-700 border border-gray-200 hover:border-red-200 rounded-md px-2 py-0.5"
                >
                  <X size={11} /> Reject {n}
                </button>
                <button onClick={() => onSelectAll(false)} className="text-[11px] text-ink-light hover:text-navy underline">
                  clear
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {list.map((r) => (
        <AnswerRow
          key={r.id}
          row={r}
          checked={selectedIds.has(r.id)}
          onToggle={() => onToggleRow(r)}
          onDone={onRowDone}
        />
      ))}
    </div>
  );
}

function BulkBtn({ children, onClick, disabled, icon }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 text-[11px] font-bold text-teal border border-teal/30 hover:bg-teal/5 rounded-md px-2 py-0.5 disabled:opacity-40"
    >
      {icon}{children}
    </button>
  );
}

// Statement-order groupings for the full-chart picker.
const PNL_GROUPS: { type: string; label: string }[] = [
  { type: "Income", label: "Revenue" },
  { type: "Cost of Goods Sold", label: "COGS" },
  { type: "Expense", label: "Expenses" },
  { type: "Other Income", label: "Other Income" },
  { type: "Other Expense", label: "Other Expenses" },
];
const BS_GROUPS: { type: string; label: string }[] = [
  { type: "Bank", label: "Bank" },
  { type: "Accounts Receivable", label: "Accounts Receivable" },
  { type: "Other Current Asset", label: "Other Current Assets" },
  { type: "Fixed Asset", label: "Fixed Assets" },
  { type: "Other Asset", label: "Other Assets" },
  { type: "Accounts Payable", label: "Accounts Payable" },
  { type: "Credit Card", label: "Credit Card" },
  { type: "Other Current Liability", label: "Other Current Liabilities" },
  { type: "Long Term Liability", label: "Long-Term Liabilities" },
  { type: "Equity", label: "Equity" },
];

function groupAccounts(all: CoaAccount[], view: "pnl" | "bs") {
  const groups = view === "pnl" ? PNL_GROUPS : BS_GROUPS;
  const inView = all.filter((a) => a.section === view);
  const out: { label: string; items: CoaAccount[] }[] = [];
  const claimed = new Set<string>();
  for (const g of groups) {
    const items = inView.filter((a) => a.type === g.type).sort((a, b) => a.name.localeCompare(b.name));
    items.forEach((i) => claimed.add(i.id));
    if (items.length) out.push({ label: g.label, items });
  }
  const rest = inView.filter((a) => !claimed.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (rest.length) out.push({ label: "Other", items: rest });
  return out;
}

/** Bulk account picker — reuses the per-row suggestions endpoint (returns the
 *  client's full chart) to populate the dropdown for the selected set. */
function AccountPicker({ sampleRowId, onClose, onPick }: {
  sampleRowId: string | undefined;
  onClose: () => void;
  onPick: (acc: { id: string; name: string }, alsoRule: boolean) => void;
}) {
  const [all, setAll] = useState<CoaAccount[] | null>(null);
  const [view, setView] = useState<"pnl" | "bs">("pnl");
  const [pick, setPick] = useState("");

  useEffect(() => {
    if (!sampleRowId) { setAll([]); return; }
    fetch(`/api/today/client-answers/${sampleRowId}/suggestions`)
      .then((r) => r.json())
      .then((j) => setAll(j.all || []))
      .catch(() => setAll([]));
  }, [sampleRowId]);

  const acc = all?.find((a) => a.id === pick);

  return (
    <div className="absolute z-20 mt-1 left-0 w-72 rounded-lg border border-gray-200 bg-white shadow-lg p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">Apply one account to all selected</span>
        <button onClick={onClose} className="text-ink-light hover:text-navy"><X size={12} /></button>
      </div>
      <div className="flex items-center gap-1">
        {([["pnl", "P&L"], ["bs", "Balance Sheet"]] as const).map(([v, label]) => (
          <button key={v} onClick={() => { setView(v); setPick(""); }}
            className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${view === v ? "bg-navy text-white border-navy" : "bg-white text-ink-slate border-gray-200"}`}>
            {label}
          </button>
        ))}
      </div>
      {all === null ? (
        <div className="text-xs text-ink-slate flex items-center gap-1.5 py-1"><Loader2 size={12} className="animate-spin" /> loading chart…</div>
      ) : (
        <select value={pick} onChange={(e) => setPick(e.target.value)} className="w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-ink-slate">
          <option value="">{view === "pnl" ? "P&L accounts…" : "Balance Sheet accounts…"}</option>
          {groupAccounts(all, view).map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
          ))}
        </select>
      )}
      <div className="flex items-center gap-1.5">
        <button onClick={() => acc && onPick({ id: acc.id, name: acc.name }, false)} disabled={!acc}
          className="flex-1 text-xs font-bold text-white bg-teal hover:bg-teal-dark rounded-lg px-2.5 py-1.5 disabled:opacity-40">
          Apply to all
        </button>
        <button onClick={() => acc && onPick({ id: acc.id, name: acc.name }, true)} disabled={!acc}
          className="flex-1 text-xs font-bold text-teal border border-teal/30 hover:bg-teal/5 rounded-lg px-2.5 py-1.5 disabled:opacity-40">
          + add rule
        </button>
      </div>
    </div>
  );
}

function AnswerRow({ row, checked, onToggle, onDone }: {
  row: ClientAnswerRow; checked: boolean; onToggle: () => void; onDone: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(row.error || "");
  const [blocked, setBlocked] = useState(false);
  const [open, setOpen] = useState(false);
  const [sugg, setSugg] = useState<Array<{ id: string; name: string; reason: string }> | null>(null);
  const [all, setAll] = useState<CoaAccount[]>([]);
  const [coaView, setCoaView] = useState<"pnl" | "bs">("pnl");
  const [pickOther, setPickOther] = useState("");

  async function act(body: any, busyKey: string) {
    setBusy(busyKey);
    setError("");
    setBlocked(false);
    try {
      const res = await fetch(`/api/today/client-answers/${row.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j.blocked) { setBlocked(true); setError(j.error || "Blocked in QuickBooks"); return; }
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onDone(row.id);
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function toggleDropdown() {
    const next = !open;
    setOpen(next);
    if (next && sugg === null) {
      try {
        const res = await fetch(`/api/today/client-answers/${row.id}/suggestions`);
        const j = await res.json();
        if (res.ok) { setSugg(j.suggestions || []); setAll(j.all || []); } else setSugg([]);
      } catch { setSugg([]); }
    }
  }

  function reject() {
    const note = window.prompt("Why reject? (optional — goes on the reclass row)");
    if (note === null) return;
    act({ action: "reject", note: note.trim() || undefined }, "reject");
  }

  return (
    <div className={`px-5 py-3 ${checked ? "bg-teal-lighter/40" : ""}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 h-3.5 w-3.5 rounded border-gray-300 text-teal focus:ring-teal flex-shrink-0"
          aria-label="Select transaction"
        />
        <div className="flex-1 min-w-[220px]">
          <div className="text-sm text-navy">
            <span className="font-semibold">{row.vendor || row.description || "Unlabeled transaction"}</span>
            <span className="text-ink-slate"> · {money(row.amount)}</span>
            {row.date && <span className="text-ink-light text-xs"> · {row.date}</span>}
          </div>
          <div className="text-xs text-ink-slate mt-0.5">
            {row.from_account && <>from <span className="font-medium">{row.from_account}</span> · </>}
            client says:{" "}
            {row.answer_account ? (
              <span className="font-semibold text-teal-dark">{row.answer_account}</span>
            ) : (
              <span className="italic">no account picked</span>
            )}
            {row.answer_note && <span className="italic"> — “{row.answer_note}”</span>}
          </div>
          {error && (
            <div className={`text-xs mt-1 ${blocked ? "text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5" : "text-red-700"}`}>
              {blocked && <span className="font-semibold">Needs a step in QuickBooks — </span>}
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {row.answer_account ? (
            <button onClick={() => act({ action: "approve" }, "approve")} disabled={!!busy}
              className="inline-flex items-center gap-1.5 text-xs font-bold bg-teal hover:bg-teal-dark text-white rounded-l-lg px-3 py-2 disabled:opacity-50">
              {busy === "approve" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Approve
            </button>
          ) : (
            <button onClick={toggleDropdown} className="inline-flex items-center gap-1.5 text-xs font-bold bg-teal hover:bg-teal-dark text-white rounded-l-lg px-3 py-2">
              Pick account
            </button>
          )}
          <button onClick={toggleDropdown} disabled={!!busy} title="Apply as a different account"
            className="inline-flex items-center text-xs font-bold bg-teal/90 hover:bg-teal-dark text-white rounded-r-lg px-1.5 py-2 border-l border-white/30 disabled:opacity-50">
            <ChevronDown size={13} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
          </button>
          <button onClick={reject} disabled={!!busy}
            className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-red-700 border border-gray-200 hover:border-red-200 rounded-lg px-2.5 py-2 disabled:opacity-50">
            {busy === "reject" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Reject
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 ml-0 sm:ml-4 rounded-lg border border-gray-200 bg-gray-50/60 p-2.5 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light flex items-center gap-1">
            <Sparkles size={10} className="text-teal" /> Similar to the client’s pick
          </div>
          {sugg === null ? (
            <div className="text-xs text-ink-slate flex items-center gap-1.5 py-1"><Loader2 size={12} className="animate-spin" /> finding similar accounts…</div>
          ) : sugg.length === 0 ? (
            <div className="text-xs text-ink-light py-1">No close matches — use the full chart below.</div>
          ) : (
            sugg.map((s) => (
              <button key={s.id} onClick={() => act({ action: "approve_as", account_id: s.id, account_name: s.name }, s.id)} disabled={!!busy}
                className="w-full flex items-center gap-2 text-left text-xs rounded-lg border border-gray-200 bg-white hover:border-teal px-2.5 py-1.5 disabled:opacity-50">
                {busy === s.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} className="text-teal" />}
                <span className="font-semibold text-navy">{s.name}</span>
                <span className="text-ink-light">{s.reason}</span>
              </button>
            ))
          )}
          {all.length > 0 && (
            <div className="pt-1 space-y-1.5">
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light mr-1">Full chart</span>
                {([["pnl", "P&L"], ["bs", "Balance Sheet"]] as const).map(([v, label]) => (
                  <button key={v} onClick={() => { setCoaView(v); setPickOther(""); }}
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${coaView === v ? "bg-navy text-white border-navy" : "bg-white text-ink-slate border-gray-200 hover:border-gray-300"}`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <select value={pickOther} onChange={(e) => setPickOther(e.target.value)}
                  className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-ink-slate">
                  <option value="">{coaView === "pnl" ? "P&L accounts (Revenue → COGS → Expenses)…" : "Balance Sheet accounts…"}</option>
                  {groupAccounts(all, coaView).map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </optgroup>
                  ))}
                </select>
                <button onClick={() => { const acc = all.find((a) => a.id === pickOther); if (acc) act({ action: "approve_as", account_id: acc.id, account_name: acc.name }, "other"); }}
                  disabled={!pickOther || !!busy}
                  className="text-xs font-bold text-teal border border-teal/30 hover:bg-teal/5 rounded-lg px-2.5 py-1.5 disabled:opacity-40">
                  {busy === "other" ? <Loader2 size={11} className="animate-spin" /> : "Apply"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
