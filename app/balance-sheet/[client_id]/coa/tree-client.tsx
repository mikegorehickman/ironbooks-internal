"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2, RefreshCw, ChevronDown, ChevronRight, ArrowRight, AlertTriangle,
  Wallet, CreditCard, FileSpreadsheet, Briefcase, Layers, BookOpen, Landmark,
  Edit2, Check, X, Plus, Pause, PlayCircle, MoveRight, List, Send, Sparkles, Search,
} from "lucide-react";

interface BsCoaAccount {
  id: string;
  name: string;
  fully_qualified_name: string;
  account_type: string;
  account_subtype: string | null;
  parent_id: string | null;
  parent_name: string | null;
  is_sub_account: boolean;
  current_balance: number;
  currency: string | null;
  active: boolean;
  depth: number;
  children: BsCoaAccount[];
}

interface BsCoaGroup {
  account_type: string;
  accounts: BsCoaAccount[];
  total_balance: number;
}

interface BsCoaResponse {
  ok: boolean;
  client_name: string;
  total_accounts: number;
  active_accounts: number;
  groups: BsCoaGroup[];
}

/**
 * Tree view of every BS account in the client's QBO COA. Read-only for
 * now — edit operations (Phase 3) will mount inline action buttons per
 * row. Each row has a "Reclass transactions" link that routes into the
 * existing scrub-mode reclass for that source account.
 */
interface MoveTargetAccount {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
}

export function BsCoaTreeClient({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const [data, setData] = useState<BsCoaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [showInactive, setShowInactive] = useState(false);
  const [addModal, setAddModal] = useState<{ type: string } | null>(null);
  // Lifted: every active QBO account, for the "Move to..." dropdown in
  // the per-account transaction drawer. Fetched once on mount so the
  // drawer opens instantly.
  const [moveTargets, setMoveTargets] = useState<MoveTargetAccount[]>([]);

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/bs-coa`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body as BsCoaResponse);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLinkId]);

  // Fetch all active QBO accounts once for the "Move to..." dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/clients/${clientLinkId}/qbo-accounts`);
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        const list: MoveTargetAccount[] = (body.accounts || [])
          .filter((a: any) => a.id && a.name)
          .map((a: any) => ({
            id: a.id,
            name: a.name,
            fullyQualifiedName: a.fullyQualifiedName || a.name,
            accountType: a.accountType || "",
          }))
          .sort((x: MoveTargetAccount, y: MoveTargetAccount) =>
            x.name.localeCompare(y.name)
          );
        setMoveTargets(list);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [clientLinkId]);

  // Flatten all groups+children into a single array so AccountRow can build
  // its "same-type valid parents" list for re-parenting.
  function flattenAll(): BsCoaAccount[] {
    if (!data) return [];
    const out: BsCoaAccount[] = [];
    function walk(node: BsCoaAccount) {
      out.push(node);
      for (const c of node.children) walk(c);
    }
    for (const g of data.groups) for (const a of g.accounts) walk(a);
    return out;
  }
  const allAccountsFlat = flattenAll();

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-teal" size={28} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm text-red-800">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">Couldn&apos;t load the BS COA</div>
            <div className="text-xs">{error}</div>
            <button
              onClick={fetchData}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-red-900 hover:text-red-700"
            >
              <RefreshCw size={11} /> Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-xs text-ink-slate">
          <strong className="text-navy">{data.active_accounts}</strong> active
          {data.total_accounts !== data.active_accounts && (
            <span className="text-ink-light">
              {" "}· {data.total_accounts - data.active_accounts} inactive
            </span>
          )}
          {" "}· {data.groups.length} sections
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-slate cursor-pointer">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-gray-300"
          />
          Show inactive
        </label>
        <Link
          href={`/balance-sheet/${clientLinkId}/uf-audit`}
          className="ml-auto inline-flex items-center gap-1.5 bg-white border-2 border-amber-500 text-amber-800 hover:bg-amber-50 text-xs font-bold px-3 py-1.5 rounded-lg"
          title="Find Receive-Payment entries in Undeposited Funds that never deposited to the bank — deterministic, group by customer, bulk JE"
        >
          <Search size={12} />
          UF Audit
        </Link>
        <Link
          href={`/balance-sheet/${clientLinkId}/coa/ai-fix`}
          className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-bold px-3 py-1.5 rounded-lg"
          title="Have Claude analyze the BS and propose fixes — review, accept/modify/reject, then push to QBO in one click"
        >
          <Sparkles size={12} />
          Use AI to fix
        </Link>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-1 text-xs text-ink-slate hover:text-navy"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Groups */}
      <div className="space-y-3">
        {data.groups.map((group) => (
          <GroupSection
            key={group.account_type}
            group={group}
            clientLinkId={clientLinkId}
            clientName={clientName}
            showInactive={showInactive}
            allAccountsFlat={allAccountsFlat}
            moveTargets={moveTargets}
            onAddClick={(type) => setAddModal({ type })}
            onMutated={fetchData}
          />
        ))}
      </div>

      <p className="text-xs text-ink-light leading-relaxed pt-3">
        Hover any row for actions: <em>Reclass</em> opens the scrub flow with
        that account as the source; the pencil renames; the arrow re-parents
        the account under another in the same type group; the pause inactivates
        (QBO blocks if there's transaction history). Use <em>Add</em> in any
        section header to create a new account from scratch.
      </p>

      {addModal && (
        <AddAccountModal
          clientLinkId={clientLinkId}
          accountType={addModal.type}
          existingAccounts={allAccountsFlat.filter((a) => a.account_type === addModal.type)}
          onClose={() => setAddModal(null)}
          onCreated={() => { setAddModal(null); fetchData(); }}
        />
      )}
    </div>
  );
}

function GroupSection({
  group,
  clientLinkId,
  clientName,
  showInactive,
  allAccountsFlat,
  moveTargets,
  onAddClick,
  onMutated,
}: {
  group: BsCoaGroup;
  clientLinkId: string;
  clientName: string;
  showInactive: boolean;
  allAccountsFlat: BsCoaAccount[];
  moveTargets: MoveTargetAccount[];
  onAddClick: (type: string) => void;
  onMutated: () => void;
}) {
  const [open, setOpen] = useState(true);

  function visibleCount(node: BsCoaAccount): number {
    let n = node.active || showInactive ? 1 : 0;
    for (const c of node.children) n += visibleCount(c);
    return n;
  }
  const visibleTotal = group.accounts.reduce((s, a) => s + visibleCount(a), 0);
  if (visibleTotal === 0 && !group.accounts.length) return null;

  const TypeIcon = iconForType(group.account_type);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          {open ? (
            <ChevronDown size={14} className="text-ink-slate" />
          ) : (
            <ChevronRight size={14} className="text-ink-slate" />
          )}
          <TypeIcon size={16} className="text-teal" />
          <span className="font-bold text-sm text-navy">{group.account_type}</span>
          <span className="text-xs text-ink-slate">({visibleTotal})</span>
        </button>
        <span className="font-mono text-sm text-navy tabular-nums">
          {formatCurrency(group.total_balance)}
        </span>
        <button
          onClick={() => onAddClick(group.account_type)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold text-teal hover:bg-teal-lighter"
          title={`Add a new ${group.account_type} account`}
        >
          <Plus size={11} />
          Add
        </button>
      </div>
      {open && (
        <div className="border-t border-gray-100">
          {group.accounts.map((acc) => (
            <AccountRow
              key={acc.id}
              account={acc}
              clientLinkId={clientLinkId}
              clientName={clientName}
              showInactive={showInactive}
              allAccountsFlat={allAccountsFlat}
              moveTargets={moveTargets}
              onMutated={onMutated}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({
  account,
  clientLinkId,
  clientName,
  showInactive,
  allAccountsFlat,
  moveTargets,
  onMutated,
}: {
  account: BsCoaAccount;
  clientLinkId: string;
  clientName: string;
  showInactive: boolean;
  allAccountsFlat: BsCoaAccount[];
  moveTargets: MoveTargetAccount[];
  onMutated: () => void;
}) {
  const [editing, setEditing] = useState<null | "rename" | "reparent">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string>("");
  const [newName, setNewName] = useState(account.name);
  const [newParentId, setNewParentId] = useState<string>("");
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (!account.active && !showInactive) return null;

  const reclassHref = `/reclass/new?client=${clientLinkId}&workflow=scrub&source_account_id=${encodeURIComponent(
    account.id
  )}&source_account_name=${encodeURIComponent(account.name)}`;

  const indentPx = account.depth * 18;

  // Candidate parents for re-parent: same account_type, not self, not a
  // descendant of self (to avoid cycles).
  const sameTypeAccounts = allAccountsFlat.filter(
    (a) => a.account_type === account.account_type && a.id !== account.id
  );
  // Detect descendants (to exclude them as parent candidates)
  function isDescendant(candidate: BsCoaAccount): boolean {
    if (candidate.id === account.id) return true;
    // Walk up via parent_id until we hit null or the candidate
    let cur: BsCoaAccount | undefined = candidate;
    while (cur && cur.parent_id) {
      if (cur.parent_id === account.id) return true;
      cur = allAccountsFlat.find((x) => x.id === cur!.parent_id);
    }
    return false;
  }
  const validParents = sameTypeAccounts.filter((a) => !isDescendant(a));

  async function callPatch(body: any, opLabel: string) {
    setBusy(opLabel);
    setRowError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/bs-coa/account/${account.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEditing(null);
      onMutated();
    } catch (e: any) {
      setRowError(e?.message || "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div
        className="flex items-center gap-3 px-4 py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50/60 group"
        style={{ paddingLeft: 16 + indentPx }}
      >
        {account.depth > 0 && (
          <span className="text-ink-light text-xs leading-none -ml-3 select-none">└</span>
        )}

        <div className="flex-1 min-w-0">
          {editing === "rename" ? (
            <div className="flex items-center gap-1.5">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                className="flex-1 px-2 py-0.5 rounded border border-teal/40 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") callPatch({ action: "rename", new_name: newName }, "rename");
                  if (e.key === "Escape") { setEditing(null); setRowError(""); setNewName(account.name); }
                }}
              />
              <button
                onClick={() => callPatch({ action: "rename", new_name: newName }, "rename")}
                disabled={busy !== null || !newName.trim() || newName === account.name}
                className="px-1.5 py-0.5 rounded bg-teal text-white text-[10px] font-bold disabled:opacity-50 inline-flex items-center gap-1"
              >
                {busy === "rename" ? <Loader2 size={9} className="animate-spin" /> : <Check size={9} />}
                Save
              </button>
              <button
                onClick={() => { setEditing(null); setRowError(""); setNewName(account.name); }}
                className="text-ink-light hover:text-ink-slate"
              >
                <X size={12} />
              </button>
            </div>
          ) : editing === "reparent" ? (
            <div className="flex items-center gap-1.5">
              <select
                value={newParentId}
                onChange={(e) => setNewParentId(e.target.value)}
                autoFocus
                className="flex-1 px-2 py-0.5 rounded border border-teal/40 text-sm"
              >
                <option value="">— pick a parent —</option>
                {validParents.map((p) => (
                  <option key={p.id} value={p.id}>{p.fully_qualified_name}</option>
                ))}
              </select>
              <button
                onClick={() => callPatch({ action: "reparent", new_parent_id: newParentId }, "reparent")}
                disabled={busy !== null || !newParentId}
                className="px-1.5 py-0.5 rounded bg-teal text-white text-[10px] font-bold disabled:opacity-50 inline-flex items-center gap-1"
              >
                {busy === "reparent" ? <Loader2 size={9} className="animate-spin" /> : <Check size={9} />}
                Move
              </button>
              <button
                onClick={() => { setEditing(null); setRowError(""); setNewParentId(""); }}
                className="text-ink-light hover:text-ink-slate"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className={`text-sm ${account.active ? "text-navy" : "text-ink-light line-through"}`}>
                {account.name}
              </span>
              {!account.active && (
                <span className="text-[10px] font-semibold text-ink-light bg-gray-100 px-1.5 py-0.5 rounded">
                  inactive
                </span>
              )}
              {account.account_subtype && (
                <span className="text-[10px] text-ink-light">· {account.account_subtype}</span>
              )}
            </div>
          )}
          {editing === null && account.is_sub_account && account.parent_name && (
            <div className="text-[10px] text-ink-light">
              sub-account of {account.parent_name}
            </div>
          )}
          {rowError && (
            <div className="text-[10px] text-red-600 font-semibold mt-0.5">{rowError}</div>
          )}
        </div>

        {editing === null && (
          <>
            <div className="font-mono text-sm tabular-nums text-navy whitespace-nowrap">
              {formatCurrency(account.current_balance)}
            </div>

            {/* Hover action toolbar */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => setDrawerOpen(!drawerOpen)}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold hover:bg-gray-100 ${drawerOpen ? "text-teal bg-teal-lighter" : "text-ink-slate"}`}
                title="Show recent transactions for this account"
              >
                <List size={10} />
                {drawerOpen ? "Hide" : "Lines"}
              </button>
              <Link
                href={reclassHref}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold text-teal hover:bg-teal-lighter"
                title="Open full scrub-reclass workflow with this as source"
              >
                <ArrowRight size={10} />
                Bulk
              </Link>
              <button
                onClick={() => { setEditing("rename"); setNewName(account.name); setRowError(""); }}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-ink-slate hover:bg-gray-100 hover:text-navy"
                title="Rename"
              >
                <Edit2 size={10} />
              </button>
              {validParents.length > 0 && (
                <button
                  onClick={() => { setEditing("reparent"); setNewParentId(""); setRowError(""); }}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-ink-slate hover:bg-gray-100 hover:text-navy"
                  title="Move under a different parent"
                >
                  <MoveRight size={10} />
                </button>
              )}
              {account.active ? (
                <button
                  onClick={() => {
                    if (!confirm(`Inactivate "${account.name}"?\n\nQBO will reject this if the account has historical transactions. You can re-activate later.`)) return;
                    callPatch({ action: "inactivate" }, "inactivate");
                  }}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-ink-slate hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                  title="Inactivate (soft delete)"
                >
                  {busy === "inactivate" ? <Loader2 size={10} className="animate-spin" /> : <Pause size={10} />}
                </button>
              ) : (
                <button
                  onClick={() => callPatch({ action: "reactivate" }, "reactivate")}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-ink-slate hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
                  title="Reactivate"
                >
                  {busy === "reactivate" ? <Loader2 size={10} className="animate-spin" /> : <PlayCircle size={10} />}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {/* Inline transaction drawer — opens under the row when the
          bookkeeper clicks the Lines button. Lazy-loads transactions. */}
      {drawerOpen && (
        <TransactionDrawer
          clientLinkId={clientLinkId}
          account={account}
          moveTargets={moveTargets}
          indentPx={indentPx + 24}
          onMutated={() => {
            // Refresh top-level tree (balances may have shifted)
            onMutated();
          }}
        />
      )}
      {account.children.map((child) => (
        <AccountRow
          key={child.id}
          account={child}
          clientLinkId={clientLinkId}
          clientName={clientName}
          showInactive={showInactive}
          allAccountsFlat={allAccountsFlat}
          moveTargets={moveTargets}
          onMutated={onMutated}
        />
      ))}
    </>
  );
}

function formatCurrency(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Inline transaction drawer — renders under an expanded AccountRow.
 * Pulls the last 90 days of lines hitting this account, then offers
 * a per-line "Move to..." dropdown with a single-line reclass execute.
 *
 * For small one-off fixes ("$500 in Undeposited Funds should be
 * Customer Deposit") this is way faster than the full scrub-reclass
 * workflow — no review screen, no batch, just pick + go.
 */
interface DrawerLine {
  transaction_id: string;
  transaction_type: string;
  line_id: string;
  sync_token: string;
  transaction_date: string;
  transaction_amount: number;
  vendor_name: string;
  description: string;
  private_note: string;
  is_reconciled: boolean;
  is_bank_fed: boolean;
  is_manual_entry: boolean;
}

function TransactionDrawer({
  clientLinkId,
  account,
  moveTargets,
  indentPx,
  onMutated,
}: {
  clientLinkId: string;
  account: BsCoaAccount;
  moveTargets: MoveTargetAccount[];
  indentPx: number;
  onMutated: () => void;
}) {
  const [lines, setLines] = useState<DrawerLine[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [days, setDays] = useState<number>(90);
  // Per-line state: which target picked + busy/error
  const [pick, setPick] = useState<Record<string, string>>({});
  const [linebusy, setLineBusy] = useState<string | null>(null);
  const [lineError, setLineError] = useState<{ id: string; msg: string } | null>(null);
  // Track which lines have been successfully moved so we can grey them
  // out without forcing a full tree refresh between each click.
  const [moved, setMoved] = useState<Set<string>>(new Set());

  async function load(d: number) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/bs-coa/transactions/${account.id}?days=${d}&limit=200`
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setLines(body.lines || []);
      setMoved(new Set());
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(days); }, [days, account.id, clientLinkId]);

  function lineKey(l: DrawerLine) {
    return `${l.transaction_id}::${l.line_id}`;
  }

  async function move(line: DrawerLine) {
    const key = lineKey(line);
    const targetId = pick[key];
    if (!targetId) {
      setLineError({ id: key, msg: "Pick a target first" });
      return;
    }
    setLineBusy(key);
    setLineError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/bs-coa/reclass-line`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction_id: line.transaction_id,
          transaction_type: line.transaction_type,
          line_id: line.line_id,
          new_account_id: targetId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMoved((prev) => new Set(prev).add(key));
    } catch (e: any) {
      setLineError({ id: key, msg: e?.message || "Failed" });
    } finally {
      setLineBusy(null);
    }
  }

  return (
    <div
      className="bg-gradient-to-b from-teal-lighter/30 to-white border-b border-gray-100"
      style={{ paddingLeft: indentPx }}
    >
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-navy uppercase tracking-wider">
            Recent transactions on {account.name}
          </span>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 bg-white"
            disabled={loading}
          >
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
            <option value={180}>last 6 months</option>
            <option value={365}>last 12 months</option>
          </select>
          {loading && <Loader2 size={11} className="animate-spin text-teal" />}
          <button
            onClick={() => load(days)}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-slate hover:text-navy"
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
            {error}
          </div>
        )}

        {!loading && lines && lines.length === 0 && (
          <div className="p-4 text-center text-xs text-ink-slate">
            No transactions hit this account in the last {days} days.
          </div>
        )}

        {lines && lines.length > 0 && (
          <div className="rounded-lg border border-gray-100 bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-ink-slate">
                  <th className="px-2 py-1.5 font-semibold">Date</th>
                  <th className="px-2 py-1.5 font-semibold">Vendor / Memo</th>
                  <th className="px-2 py-1.5 font-semibold">Type</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Amount</th>
                  <th className="px-2 py-1.5 font-semibold">Move to</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Go</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const k = lineKey(l);
                  const isBusy = linebusy === k;
                  const hasMoved = moved.has(k);
                  const err = lineError?.id === k ? lineError.msg : null;
                  return (
                    <tr
                      key={k}
                      className={`border-b border-gray-50 last:border-0 ${hasMoved ? "bg-emerald-50/40 opacity-70" : "hover:bg-gray-50/40"}`}
                    >
                      <td className="px-2 py-1.5 text-ink-slate whitespace-nowrap">
                        {l.transaction_date}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="text-navy">{l.vendor_name || "—"}</div>
                        {l.description && (
                          <div className="text-[10px] text-ink-light truncate max-w-xs">{l.description}</div>
                        )}
                        <div className="flex gap-1 mt-0.5">
                          {l.is_reconciled && (
                            <span className="text-[9px] bg-red-100 text-red-700 px-1 rounded">reconciled</span>
                          )}
                          {l.is_bank_fed && (
                            <span className="text-[9px] bg-blue-100 text-blue-700 px-1 rounded">bank-fed</span>
                          )}
                          {l.is_manual_entry && (
                            <span className="text-[9px] bg-amber-100 text-amber-700 px-1 rounded">manual</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-[10px] text-ink-slate">{l.transaction_type}</td>
                      <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap text-navy">
                        {formatCurrency(l.transaction_amount)}
                      </td>
                      <td className="px-2 py-1.5">
                        {hasMoved ? (
                          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 font-semibold">
                            <Check size={10} /> Moved
                          </span>
                        ) : (
                          <select
                            value={pick[k] || ""}
                            onChange={(e) => setPick({ ...pick, [k]: e.target.value })}
                            disabled={l.is_reconciled || isBusy}
                            className="text-xs px-1.5 py-0.5 rounded border border-gray-200 max-w-[200px] disabled:opacity-50"
                          >
                            <option value="">— select target —</option>
                            {moveTargets
                              .filter((t) => t.id !== account.id)
                              .map((t) => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                          </select>
                        )}
                        {err && (
                          <div className="text-[10px] text-red-600 font-semibold mt-0.5">{err}</div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {!hasMoved && (
                          <button
                            onClick={() => move(l)}
                            disabled={isBusy || !pick[k] || l.is_reconciled}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-teal hover:bg-teal-dark text-white text-[10px] font-bold disabled:opacity-50"
                            title={l.is_reconciled ? "Reconciled lines can't be reclassed" : "Push the move to QBO"}
                          >
                            {isBusy ? <Loader2 size={9} className="animate-spin" /> : <Send size={9} />}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {moved.size > 0 && (
              <div className="px-2 py-1.5 bg-emerald-50 border-t border-emerald-100 text-[10px] text-emerald-800 flex items-center justify-between">
                <span>{moved.size} line{moved.size === 1 ? "" : "s"} moved this session — balances will refresh on next tree reload.</span>
                <button
                  onClick={onMutated}
                  className="text-emerald-900 font-bold hover:text-emerald-700"
                >
                  Refresh tree now
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Add-account modal — free-form create. Subtype suggestions per type help
 * the bookkeeper pick a valid QBO enum on the first try (QBO will reject
 * invalid subtype/type combos with a confusing error otherwise).
 */
function AddAccountModal({
  clientLinkId,
  accountType,
  existingAccounts,
  onClose,
  onCreated,
}: {
  clientLinkId: string;
  accountType: string;
  existingAccounts: BsCoaAccount[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [subtype, setSubtype] = useState(DEFAULT_SUBTYPE[accountType] || "");
  const [parentId, setParentId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const subtypeOptions = SUBTYPES_BY_TYPE[accountType] || [];

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/bs-coa/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          account_type: accountType,
          account_subtype: subtype,
          parent_id: parentId || undefined,
          description: description.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onCreated();
    } catch (e: any) {
      setErr(e?.message || "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-bold text-navy">Add {accountType} account</h3>
          <button onClick={onClose} className="text-ink-light hover:text-ink-slate">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-navy">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Petty Cash, Truck Loan, Owner Contributions"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-navy">Subtype</span>
            {subtypeOptions.length > 0 ? (
              <select
                value={subtype}
                onChange={(e) => setSubtype(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm"
              >
                <option value="">— pick a subtype —</option>
                {subtypeOptions.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            ) : (
              <input
                value={subtype}
                onChange={(e) => setSubtype(e.target.value)}
                placeholder="QBO subtype enum (e.g. Checking, Inventory)"
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm font-mono"
              />
            )}
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-navy">
              Parent <span className="text-ink-light font-normal">(optional)</span>
            </span>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm"
            >
              <option value="">— root account —</option>
              {existingAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.fully_qualified_name}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-navy">
              Description <span className="text-ink-light font-normal">(optional)</span>
            </span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm"
            />
          </label>

          {err && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
              {err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !name.trim() || !subtype}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold rounded-lg disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// QBO subtype enums per account type. Not exhaustive — these are the
// painter-relevant ones. Bookkeeper can still type a freeform value if
// what they need isn't in the dropdown.
const SUBTYPES_BY_TYPE: Record<string, Array<{ value: string; label: string }>> = {
  Bank: [
    { value: "Checking", label: "Checking" },
    { value: "Savings", label: "Savings" },
    { value: "MoneyMarket", label: "Money Market" },
    { value: "CashOnHand", label: "Cash on Hand (Petty Cash)" },
    { value: "TrustAccounts", label: "Trust Account" },
  ],
  "Credit Card": [
    { value: "CreditCard", label: "Credit Card" },
  ],
  "Accounts Receivable": [
    { value: "AccountsReceivable", label: "Accounts Receivable" },
  ],
  "Other Current Asset": [
    { value: "Inventory", label: "Inventory" },
    { value: "PrepaidExpenses", label: "Prepaid Expenses" },
    { value: "EmployeeCashAdvances", label: "Employee Cash Advances" },
    { value: "UndepositedFunds", label: "Undeposited Funds" },
    { value: "LoansToOthers", label: "Loans to Others" },
    { value: "OtherCurrentAssets", label: "Other Current Assets" },
  ],
  "Fixed Asset": [
    { value: "Vehicles", label: "Vehicles" },
    { value: "MachineryAndEquipment", label: "Machinery / Equipment" },
    { value: "FurnitureAndFixtures", label: "Furniture / Fixtures" },
    { value: "Buildings", label: "Buildings" },
    { value: "Land", label: "Land" },
    { value: "AccumulatedDepreciation", label: "Accumulated Depreciation" },
    { value: "OtherFixedAssets", label: "Other Fixed Assets" },
  ],
  "Other Asset": [
    { value: "SecurityDeposits", label: "Security Deposits" },
    { value: "OtherLongTermAssets", label: "Other Long Term Assets" },
  ],
  "Accounts Payable": [
    { value: "AccountsPayable", label: "Accounts Payable" },
  ],
  "Other Current Liability": [
    { value: "OtherCurrentLiabilities", label: "Other Current Liabilities" },
    { value: "PayrollClearing", label: "Payroll Clearing" },
    { value: "PayrollTaxPayable", label: "Payroll Tax Payable" },
    { value: "SalesTaxPayable", label: "Sales Tax Payable" },
    { value: "FederalIncomeTaxPayable", label: "Federal Income Tax Payable" },
    { value: "LineOfCredit", label: "Line of Credit" },
  ],
  "Long Term Liability": [
    { value: "NotesPayable", label: "Notes Payable" },
    { value: "OtherLongTermLiabilities", label: "Other Long Term Liabilities" },
    { value: "ShareholderNotesPayable", label: "Shareholder Notes Payable" },
  ],
  Equity: [
    { value: "OwnersEquity", label: "Owner's Equity" },
    { value: "PartnersEquity", label: "Partners' Equity" },
    { value: "OpeningBalanceEquity", label: "Opening Balance Equity" },
    { value: "RetainedEarnings", label: "Retained Earnings" },
    { value: "PaidInCapitalOrSurplus", label: "Paid-In Capital" },
  ],
};
const DEFAULT_SUBTYPE: Record<string, string> = {
  Bank: "Checking",
  "Credit Card": "CreditCard",
  "Accounts Receivable": "AccountsReceivable",
  "Other Current Asset": "OtherCurrentAssets",
  "Fixed Asset": "OtherFixedAssets",
  "Other Asset": "OtherLongTermAssets",
  "Accounts Payable": "AccountsPayable",
  "Other Current Liability": "OtherCurrentLiabilities",
  "Long Term Liability": "OtherLongTermLiabilities",
  Equity: "OwnersEquity",
};

function iconForType(type: string) {
  switch (type) {
    case "Bank":
      return Wallet;
    case "Credit Card":
      return CreditCard;
    case "Accounts Receivable":
      return FileSpreadsheet;
    case "Fixed Asset":
    case "Other Asset":
    case "Other Current Asset":
      return Briefcase;
    case "Accounts Payable":
      return FileSpreadsheet;
    case "Other Current Liability":
    case "Long Term Liability":
      return Layers;
    case "Equity":
      return Landmark;
    default:
      return BookOpen;
  }
}
