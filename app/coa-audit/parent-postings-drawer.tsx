"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, X, Check, Wand2 } from "lucide-react";

/**
 * Granular parent-postings fixer — the "mini reclass" for one parent account.
 *
 * The sweep's one-click Move sends EVERY posting on a parent to a single
 * sub-account. That's right for a uniform pile (Utilities → Utilities) and wrong
 * for most of them: "Payroll" with $261K on the parent splits across Owner's
 * Payroll / Admin Team / Sales Team / Employer Taxes, and dumping it all in one
 * child just relocates the error. This drawer lists the parent's own
 * transactions and lets a bookkeeper assign each one — with a vendor-grouping
 * shortcut so 40 identical charges are one decision, not forty.
 *
 * Reads ../transactions (read-only, same id-based filter as the fixer) and
 * writes through the fixer's `assignments` mode. Nothing is sent until you press
 * Apply, and the fixer still dry-runs first, skips closed periods, and refuses
 * stale lines.
 */

interface Child { id: string; name: string }
interface Txn {
  txn_key: string;
  tx_type: string;
  tx_id: string;
  date: string;
  vendor: string;
  description: string;
  amount: number;
  line_ids: string[];
  is_reconciled: boolean;
  in_closed_period: boolean;
}

const money = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Loose vendor key so "HOME DEPOT #4412" and "Home Depot" group together. */
function vendorKey(v: string) {
  return (v || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function ParentPostingsDrawer({
  clientLinkId,
  clientName,
  parentId,
  parentName,
  onClose,
  onDone,
}: {
  clientLinkId: string;
  clientName: string;
  parentId: string;
  parentName: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [txns, setTxns] = useState<Txn[]>([]);
  const [children, setChildren] = useState<Child[]>([]);
  const [win, setWin] = useState<{ start: string; end: string } | null>(null);
  const [scope, setScope] = useState<"ytd" | "prior">("ytd");

  /** txn_key → child id. The heart of the thing: one decision per transaction. */
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState("");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState("");
  const [nonce, setNonce] = useState(0); // bumped after a write → refetch

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const year = new Date().getFullYear();
    const range =
      scope === "ytd"
        ? { start: `${year}-01-01`, end: new Date().toISOString().slice(0, 10) }
        : { start: `${year - 1}-01-01`, end: `${year - 1}-12-31` };
    fetch("/api/admin/coa-parent-postings/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_link_id: clientLinkId, parent_account_id: parentId, ...range }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) { setError(d.error); return; }
        setTxns(d.txns || []);
        setChildren(d.children || []);
        setWin(d.window || range);
        setAssign({});
        setSelected(new Set());
      })
      .catch((e) => !cancelled && setError(e?.message || "Couldn't load transactions"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [clientLinkId, parentId, scope, nonce]);

  const movable = useMemo(() => txns.filter((t) => !t.in_closed_period), [txns]);
  const assignedCount = useMemo(
    () => movable.filter((t) => assign[t.txn_key]).length,
    [movable, assign]
  );
  const assignedAmount = useMemo(
    () => movable.filter((t) => assign[t.txn_key]).reduce((s, t) => s + Math.abs(t.amount), 0),
    [movable, assign]
  );

  /** Vendor groups, biggest first — the fastest way to clear a big parent. */
  const vendorGroups = useMemo(() => {
    const m = new Map<string, { label: string; keys: string[]; amount: number }>();
    for (const t of movable) {
      const k = vendorKey(t.vendor) || "(no vendor)";
      const g = m.get(k) || { label: t.vendor || "(no vendor)", keys: [], amount: 0 };
      g.keys.push(t.txn_key);
      g.amount += Math.abs(t.amount);
      m.set(k, g);
    }
    return [...m.values()].filter((g) => g.keys.length > 1).sort((a, b) => b.amount - a.amount);
  }, [movable]);

  function toggle(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  function applyToSelected(childId: string) {
    if (!childId || selected.size === 0) return;
    setAssign((a) => {
      const n = { ...a };
      for (const k of selected) n[k] = childId;
      return n;
    });
    setSelected(new Set());
  }

  async function apply() {
    const assignments = Object.entries(assign)
      .filter(([k, v]) => v && movable.some((t) => t.txn_key === k))
      .map(([txn_key, child_account_id]) => ({ txn_key, child_account_id }));
    if (assignments.length === 0) return;

    setApplying(true);
    setResult("");
    try {
      const base = {
        client_link_id: clientLinkId,
        parent_account_id: parentId,
        assignments,
        start: win?.start,
        end: win?.end,
      };
      const dry = await (
        await fetch("/api/admin/coa-parent-postings/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(base),
        })
      ).json();
      if (dry.error) { setResult(dry.error); return; }

      const byChild = new Map<string, number>();
      for (const a of assignments) byChild.set(a.child_account_id, (byChild.get(a.child_account_id) || 0) + 1);
      const breakdown = [...byChild.entries()]
        .map(([id, n]) => `  • ${n} → ${children.find((c) => c.id === id)?.name || id}`)
        .join("\n");
      if (
        !confirm(
          `Move ${dry.txns_found} transaction(s) / ${money(dry.amount_found)} off "${parentName}" for ${clientName}:\n\n${breakdown}\n\nThis re-points those lines in live QuickBooks.`
        )
      ) {
        setResult("");
        return;
      }

      const r = await (
        await fetch("/api/admin/coa-parent-postings/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, dry_run: false }),
        })
      ).json();
      if (r.error) { setResult(r.error); return; }
      const parts = [`${r.moved_txns} moved`];
      if (r.skipped_closed) parts.push(`${r.skipped_closed} closed-skip`);
      if (r.already_moved) parts.push(`${r.already_moved} already moved`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.remaining) parts.push(`${r.remaining} left — apply again`);
      setResult("✓ " + parts.join(" · "));

      // Re-read from QBO rather than guessing what landed — the list then shows
      // exactly what's still on the parent (including anything that failed or was
      // cut off by the per-pass budget, so a second Apply is straightforward).
      if (r.moved_txns > 0) {
        setNonce((n) => n + 1);
        onDone?.();
      }
    } catch (e: any) {
      setResult(e?.message || "failed");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-3xl h-full bg-white shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-bold text-navy truncate">{parentName}</div>
            <div className="text-[11px] text-ink-slate">
              {clientName} · transactions posted directly on this parent
            </div>
          </div>
          <button onClick={onClose} className="text-ink-light hover:text-navy shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Scope + bulk assign */}
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50/60 space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="text-ink-slate font-semibold">Period:</span>
            {(["ytd", "prior"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2 py-1 rounded font-semibold ${
                  scope === s ? "bg-navy text-white" : "bg-white border border-gray-300 text-navy"
                }`}
              >
                {s === "ytd" ? "This year" : `${new Date().getFullYear() - 1}`}
              </button>
            ))}
            {win && <span className="text-ink-light">{win.start} → {win.end}</span>}
          </div>

          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="text-ink-slate font-semibold">
              {selected.size} selected →
            </span>
            <select
              value={bulkTarget}
              onChange={(e) => {
                setBulkTarget(e.target.value);
                applyToSelected(e.target.value);
                setBulkTarget("");
              }}
              disabled={selected.size === 0 || children.length === 0}
              className="rounded border border-gray-300 px-1.5 py-1 bg-white max-w-[240px] disabled:opacity-50"
            >
              <option value="">Assign to sub-account…</option>
              {children.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button
              onClick={() => setSelected(new Set(movable.map((t) => t.txn_key)))}
              className="text-teal font-semibold hover:underline"
            >
              select all {movable.length}
            </button>
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="text-ink-slate hover:underline">
                clear
              </button>
            )}
          </div>

          {/* Vendor shortcuts — the big win on high-volume parents. */}
          {vendorGroups.length > 0 && (
            <div className="flex items-start gap-1.5 flex-wrap text-[11px]">
              <span className="inline-flex items-center gap-1 text-ink-slate font-semibold">
                <Wand2 size={11} /> Same vendor:
              </span>
              {vendorGroups.slice(0, 8).map((g) => (
                <button
                  key={g.label}
                  onClick={() => setSelected(new Set(g.keys))}
                  title={`Select all ${g.keys.length} — ${money(g.amount)}`}
                  className="px-1.5 py-0.5 rounded bg-white border border-gray-300 text-navy hover:border-teal"
                >
                  {g.label} <span className="text-ink-light">×{g.keys.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Transactions */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-ink-slate py-6">
              <Loader2 size={14} className="animate-spin" /> Pulling this parent&rsquo;s transactions…
            </div>
          )}
          {error && (
            <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{error}</div>
          )}
          {!loading && !error && txns.length === 0 && (
            <div className="text-xs text-ink-slate py-6">
              No expense-family postings on this parent in this window. Journal entries and
              deposits sitting on a parent are out of this tool&rsquo;s scope — fix those in QuickBooks.
            </div>
          )}
          {children.length === 0 && !loading && txns.length > 0 && (
            <div className="mb-3 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              This parent has no active sub-accounts. Add one in QuickBooks first — there&rsquo;s
              nowhere to move these to.
            </div>
          )}

          <div className="space-y-1">
            {txns.map((t) => {
              const target = assign[t.txn_key];
              const isSel = selected.has(t.txn_key);
              return (
                <div
                  key={t.txn_key}
                  className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                    t.in_closed_period
                      ? "border-gray-100 bg-gray-50 opacity-60"
                      : target
                      ? "border-teal/40 bg-teal-light/20"
                      : isSel
                      ? "border-navy/30 bg-navy/5"
                      : "border-gray-100 bg-white"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    disabled={t.in_closed_period}
                    onChange={() => toggle(t.txn_key)}
                    className="shrink-0 accent-teal"
                  />
                  <span className="font-mono text-[10px] text-ink-light w-[70px] shrink-0">{t.date}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-semibold text-navy">{t.vendor || "(no vendor)"}</span>
                    {t.description && <span className="text-ink-slate"> · {t.description}</span>}
                    <span className="text-ink-light"> · {t.tx_type}</span>
                    {t.in_closed_period && (
                      <span className="text-amber-700 font-semibold"> · closed period</span>
                    )}
                    {t.is_reconciled && <span className="text-ink-light"> · reconciled</span>}
                  </span>
                  <span className="font-mono shrink-0 w-[92px] text-right">{money(t.amount)}</span>
                  <select
                    value={target || ""}
                    disabled={t.in_closed_period || children.length === 0}
                    onChange={(e) =>
                      setAssign((a) => {
                        const n = { ...a };
                        if (e.target.value) n[t.txn_key] = e.target.value;
                        else delete n[t.txn_key];
                        return n;
                      })
                    }
                    className="text-[11px] rounded border border-gray-300 px-1 py-0.5 bg-white w-[190px] shrink-0 disabled:opacity-50"
                  >
                    <option value="">— leave on parent —</option>
                    {children.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 bg-white flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[11px] text-ink-slate">
            {assignedCount > 0 ? (
              <>
                <strong className="text-navy">{assignedCount}</strong> assigned ·{" "}
                <span className="font-mono">{money(assignedAmount)}</span>
                {movable.length > assignedCount && (
                  <span className="text-ink-light"> · {movable.length - assignedCount} still on the parent</span>
                )}
              </>
            ) : (
              <span className="text-ink-light">Assign transactions to sub-accounts, then apply.</span>
            )}
            {result && <div className="mt-0.5 text-navy font-semibold">{result}</div>}
          </div>
          <button
            onClick={apply}
            disabled={applying || assignedCount === 0}
            className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
          >
            {applying ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Apply {assignedCount || ""} to QuickBooks
          </button>
        </div>
      </div>
    </div>
  );
}
