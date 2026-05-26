"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { INDUSTRIES } from "@/lib/industries";
import {
  Plus,
  Edit2,
  Trash2,
  Save,
  X,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  GripVertical,
  Search,
  Eye,
  Star,
  ArrowUp,
  ArrowDown,
  Lock,
} from "lucide-react";
import { AddAccountModal } from "./add-account-modal";

interface MasterAccount {
  id: string;
  jurisdiction: "US" | "CA";
  account_name: string;
  parent_account_name: string | null;
  is_parent: boolean | null;
  qbo_account_type: string;
  qbo_account_subtype: string;
  sort_order: number;
  section: string;
  expense_category: string | null;
  notes: string | null;
  is_required: boolean | null;
  tax_treatment: any;
  typical_pct_revenue: number | null;
  usage: {
    times_used_in_cleanups: number;
    times_used_in_rules: number;
  };
}

const SECTION_COLORS: Record<string, { bg: string; color: string; label: string }> = {
  revenue: { bg: "#D1FAE5", color: "#065F46", label: "Revenue" },
  cogs: { bg: "#FEF3C7", color: "#92400E", label: "COGS" },
  operating_expense: { bg: "#E0E7FF", color: "#3730A3", label: "Operating Expense" },
  other_income: { bg: "#FCE7F3", color: "#9F1239", label: "Other Income" },
  other_expense: { bg: "#FEE2E2", color: "#991B1B", label: "Other Expense" },
  equity: { bg: "#F3E8FF", color: "#6B21A8", label: "Equity" },
  asset: { bg: "#DBEAFE", color: "#1E3A8A", label: "Asset" },
  liability: { bg: "#FFE4E6", color: "#9F1239", label: "Liability" },
  gross_profit: { bg: "#F1F5F9", color: "#475569", label: "Gross Profit" },
};

export function MasterCOAEditor({
  initialUS,
  initialCA,
  canEdit,
  currentIndustry = "painters",
}: {
  initialUS: MasterAccount[];
  initialCA: MasterAccount[];
  canEdit: boolean;
  currentIndustry?: string;
}) {
  const router = useRouter();
  const [jurisdiction, setJurisdiction] = useState<"US" | "CA">("US");
  const [accounts, setAccounts] = useState({ US: initialUS, CA: initialCA });
  const [search, setSearch] = useState("");
  const [filterSection, setFilterSection] = useState<string>("all");
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    new Set(initialUS.filter((a) => a.is_parent).map((a) => a.account_name))
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<MasterAccount>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addModalParent, setAddModalParent] = useState<string | null>(null);

  const currentAccounts = accounts[jurisdiction];

  // Organize as parents → children for rendering
  const organized = useMemo(() => {
    const parents = currentAccounts.filter((a) => a.is_parent);
    const standalones = currentAccounts.filter((a) => !a.is_parent && !a.parent_account_name);
    const childrenByParent = new Map<string, MasterAccount[]>();

    for (const child of currentAccounts.filter((a) => !a.is_parent && a.parent_account_name)) {
      const arr = childrenByParent.get(child.parent_account_name!) || [];
      arr.push(child);
      childrenByParent.set(child.parent_account_name!, arr);
    }

    // Apply filters
    const matchesFilter = (a: MasterAccount): boolean => {
      if (filterSection !== "all" && a.section !== filterSection) return false;
      if (search) {
        const s = search.toLowerCase();
        return (
          a.account_name.toLowerCase().includes(s) ||
          a.qbo_account_type.toLowerCase().includes(s) ||
          a.qbo_account_subtype.toLowerCase().includes(s) ||
          (a.notes || "").toLowerCase().includes(s)
        );
      }
      return true;
    };

    const result: Array<{ parent: MasterAccount | null; children: MasterAccount[] }> = [];

    for (const parent of parents.sort((a, b) => a.sort_order - b.sort_order)) {
      const children = (childrenByParent.get(parent.account_name) || []).sort(
        (a, b) => a.sort_order - b.sort_order
      );

      const parentMatches = matchesFilter(parent);
      const matchingChildren = children.filter(matchesFilter);

      if (parentMatches || matchingChildren.length > 0) {
        result.push({
          parent,
          children: search || filterSection !== "all" ? matchingChildren : children,
        });
      }
    }

    const matchingStandalones = standalones.filter(matchesFilter).sort((a, b) => a.sort_order - b.sort_order);
    if (matchingStandalones.length > 0) {
      result.push({ parent: null, children: matchingStandalones });
    }

    return result;
  }, [currentAccounts, search, filterSection]);

  const stats = useMemo(() => {
    const total = currentAccounts.length;
    const parents = currentAccounts.filter((a) => a.is_parent).length;
    const children = total - parents;
    const required = currentAccounts.filter((a) => a.is_required).length;
    return { total, parents, children, required };
  }, [currentAccounts]);

  function startEdit(account: MasterAccount) {
    if (!canEdit) return;
    setEditingId(account.id);
    setEditValues({
      account_name: account.account_name,
      qbo_account_type: account.qbo_account_type,
      qbo_account_subtype: account.qbo_account_subtype,
      notes: account.notes || "",
      is_required: account.is_required ?? false,
      typical_pct_revenue: account.typical_pct_revenue,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValues({});
  }

  async function saveEdit(id: string) {
    setSaving(id);
    const res = await fetch(`/api/master-coa/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editValues),
    });

    if (!res.ok) {
      const { error } = await res.json();
      alert(`Save failed: ${error}`);
      setSaving(null);
      return;
    }

    const { account } = await res.json();
    setAccounts((prev) => ({
      ...prev,
      [jurisdiction]: prev[jurisdiction].map((a) =>
        a.id === id ? { ...a, ...account } : a
      ),
    }));
    setEditingId(null);
    setEditValues({});
    setSaving(null);
    router.refresh();
  }

  async function deleteAccount(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

    setSaving(id);
    const res = await fetch(`/api/master-coa/${id}`, { method: "DELETE" });

    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
      setSaving(null);
      return;
    }

    setAccounts((prev) => ({
      ...prev,
      [jurisdiction]: prev[jurisdiction].filter((a) => a.id !== id),
    }));
    setSaving(null);
    router.refresh();
  }

  async function reorderChild(account: MasterAccount, direction: "up" | "down") {
    // Find sibling immediately above or below
    const siblings = currentAccounts
      .filter((a) => a.parent_account_name === account.parent_account_name && a.id !== account.id)
      .sort((a, b) => a.sort_order - b.sort_order);

    const allAtLevel = [...siblings, account].sort((a, b) => a.sort_order - b.sort_order);
    const idx = allAtLevel.findIndex((a) => a.id === account.id);
    const swapWith = direction === "up" ? allAtLevel[idx - 1] : allAtLevel[idx + 1];

    if (!swapWith) return;

    const updates = [
      { id: account.id, sort_order: swapWith.sort_order },
      { id: swapWith.id, sort_order: account.sort_order },
    ];

    // Optimistic update
    setAccounts((prev) => ({
      ...prev,
      [jurisdiction]: prev[jurisdiction].map((a) => {
        const u = updates.find((x) => x.id === a.id);
        return u ? { ...a, sort_order: u.sort_order } : a;
      }),
    }));

    await fetch("/api/master-coa/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
  }

  function onAccountAdded(newAccount: MasterAccount) {
    setAccounts((prev) => ({
      ...prev,
      [jurisdiction]: [...prev[jurisdiction], { ...newAccount, usage: { times_used_in_cleanups: 0, times_used_in_rules: 0 } }],
    }));
    setAddModalOpen(false);
    setAddModalParent(null);

    // Auto-expand parent if we added a child
    if (newAccount.parent_account_name) {
      setExpandedParents((prev) => new Set([...prev, newAccount.parent_account_name!]));
    }
    router.refresh();
  }

  function toggleParent(name: string) {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div>
      {/* Industry selector — picks which trades industry's COA to view/edit */}
      <div className="flex items-center gap-3 mb-5 p-3 rounded-xl bg-white border border-gray-200">
        <label className="text-xs font-bold uppercase tracking-wider text-ink-slate">
          Industry
        </label>
        <select
          value={currentIndustry}
          onChange={(e) => router.push(`/templates?industry=${e.target.value}`)}
          className="flex-1 max-w-xs px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm font-semibold text-navy bg-white"
        >
          {INDUSTRIES.map((ind) => (
            <option key={ind.key} value={ind.key}>
              {ind.emoji}  {ind.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-ink-light">
          Each industry has its own master COA template — accounts customize per trade
        </span>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <Stat label="Total Accounts" value={stats.total} />
        <Stat label="Parents" value={stats.parents} />
        <Stat label="Children" value={stats.children} />
        <Stat label="Required" value={stats.required} highlight />
      </div>

      {/* Toolbar */}
      <div className="rounded-xl bg-white border border-gray-200 mb-4">
        <div className="flex items-center justify-between border-b border-gray-200">
          {/* Jurisdiction tabs */}
          <div className="flex">
            <button
              onClick={() => setJurisdiction("US")}
              className={`px-5 py-3.5 text-sm font-semibold transition-colors border-b-2 ${
                jurisdiction === "US"
                  ? "border-teal text-teal"
                  : "border-transparent text-ink-slate hover:text-navy"
              }`}
            >
              🇺🇸 United States ({accounts.US.length})
            </button>
            <button
              onClick={() => setJurisdiction("CA")}
              className={`px-5 py-3.5 text-sm font-semibold transition-colors border-b-2 ${
                jurisdiction === "CA"
                  ? "border-teal text-teal"
                  : "border-transparent text-ink-slate hover:text-navy"
              }`}
            >
              🇨🇦 Canada ({accounts.CA.length})
            </button>
          </div>

          {canEdit && (
            <button
              onClick={() => {
                setAddModalParent(null);
                setAddModalOpen(true);
              }}
              className="mr-4 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <Plus size={16} />
              Add Account
            </button>
          )}
        </div>

        {/* Search + filter */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2 flex-1">
            <Search size={16} className="text-ink-light" />
            <input
              type="text"
              placeholder="Search by name, type, or notes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 px-2 py-1.5 text-sm outline-none text-navy"
            />
          </div>

          <select
            value={filterSection}
            onChange={(e) => setFilterSection(e.target.value)}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="all">All Sections</option>
            <option value="revenue">Revenue</option>
            <option value="cogs">COGS</option>
            <option value="operating_expense">Operating Expense</option>
            <option value="other_income">Other Income</option>
            <option value="other_expense">Other Expense</option>
            <option value="asset">Asset</option>
            <option value="liability">Liability</option>
            <option value="equity">Equity</option>
          </select>
        </div>
      </div>

      {!canEdit && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 mb-4 flex items-center gap-2 text-sm text-blue-900">
          <Lock size={14} />
          Read-only view. Only Admins and Leads can edit the Master COA.
        </div>
      )}

      {/* Account tree */}
      <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
        {organized.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-slate">
            No accounts match your filters.
          </p>
        ) : (
          organized.map((group, gIdx) => (
            <div key={group.parent?.id || `standalone-${gIdx}`}>
              {group.parent && (
                <ParentRow
                  account={group.parent}
                  childCount={group.children.length}
                  expanded={expandedParents.has(group.parent.account_name)}
                  onToggle={() => toggleParent(group.parent!.account_name)}
                  editing={editingId === group.parent.id}
                  editValues={editValues}
                  setEditValues={setEditValues}
                  onEdit={() => startEdit(group.parent!)}
                  onSave={() => saveEdit(group.parent!.id)}
                  onCancel={cancelEdit}
                  onDelete={() => deleteAccount(group.parent!.id, group.parent!.account_name)}
                  onAddChild={() => {
                    setAddModalParent(group.parent!.account_name);
                    setAddModalOpen(true);
                  }}
                  canEdit={canEdit}
                  saving={saving === group.parent.id}
                />
              )}
              {(!group.parent || expandedParents.has(group.parent.account_name)) &&
                group.children.map((child, idx) => (
                  <ChildRow
                    key={child.id}
                    account={child}
                    isFirstChild={idx === 0}
                    isLastChild={idx === group.children.length - 1}
                    editing={editingId === child.id}
                    editValues={editValues}
                    setEditValues={setEditValues}
                    onEdit={() => startEdit(child)}
                    onSave={() => saveEdit(child.id)}
                    onCancel={cancelEdit}
                    onDelete={() => deleteAccount(child.id, child.account_name)}
                    onMoveUp={() => reorderChild(child, "up")}
                    onMoveDown={() => reorderChild(child, "down")}
                    canEdit={canEdit}
                    saving={saving === child.id}
                  />
                ))}
            </div>
          ))
        )}
      </div>

      {addModalOpen && (
        <AddAccountModal
          jurisdiction={jurisdiction}
          industry={currentIndustry}
          presetParent={addModalParent}
          existingAccounts={currentAccounts}
          onClose={() => {
            setAddModalOpen(false);
            setAddModalParent(null);
          }}
          onAdded={onAccountAdded}
        />
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="p-4 rounded-xl bg-white border border-gray-200">
      <div
        className="text-2xl font-bold tracking-tight"
        style={{ color: highlight ? "#F59E0B" : "#0F1F2E" }}
      >
        {value}
      </div>
      <div className="text-xs mt-1 font-semibold text-ink-slate">{label}</div>
    </div>
  );
}

function ParentRow({
  account,
  childCount,
  expanded,
  onToggle,
  editing,
  editValues,
  setEditValues,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onAddChild,
  canEdit,
  saving,
}: {
  account: MasterAccount;
  childCount: number;
  expanded: boolean;
  onToggle: () => void;
  editing: boolean;
  editValues: Partial<MasterAccount>;
  setEditValues: (v: Partial<MasterAccount>) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onAddChild: () => void;
  canEdit: boolean;
  saving: boolean;
}) {
  const sec = SECTION_COLORS[account.section] || SECTION_COLORS.operating_expense;
  const totalUsage = account.usage.times_used_in_cleanups + account.usage.times_used_in_rules;

  return (
    <div className="grid items-center px-5 py-3 bg-gray-50 border-b border-gray-200 hover:bg-gray-100/50"
         style={{ gridTemplateColumns: "auto 2.5fr 1.5fr 1fr 0.8fr auto" }}>
      <button onClick={onToggle} className="text-ink-slate hover:text-navy mr-2">
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>

      <div className="flex items-center gap-2 min-w-0">
        {editing ? (
          <input
            type="text"
            value={editValues.account_name || ""}
            onChange={(e) => setEditValues({ ...editValues, account_name: e.target.value })}
            className="flex-1 px-2 py-1 border border-teal rounded text-sm font-bold outline-none text-navy"
            autoFocus
          />
        ) : (
          <>
            <span className="font-bold text-sm text-navy truncate">{account.account_name}</span>
            <span className="text-xs text-ink-slate flex-shrink-0">({childCount})</span>
            {account.is_required && (
              <Star size={12} className="text-yellow-500 fill-yellow-500 flex-shrink-0" />
            )}
          </>
        )}
      </div>

      <div className="text-xs text-ink-slate truncate">
        {editing ? (
          <div className="flex flex-col gap-1">
            <input
              type="text"
              value={editValues.qbo_account_type || ""}
              onChange={(e) => setEditValues({ ...editValues, qbo_account_type: e.target.value })}
              placeholder="QBO Type"
              className="px-2 py-1 border border-gray-200 rounded text-xs outline-none focus:border-teal text-navy"
            />
            <input
              type="text"
              value={editValues.qbo_account_subtype || ""}
              onChange={(e) => setEditValues({ ...editValues, qbo_account_subtype: e.target.value })}
              placeholder="QBO Subtype"
              className="px-2 py-1 border border-gray-200 rounded text-xs outline-none focus:border-teal text-navy"
            />
          </div>
        ) : (
          <>
            <div className="font-semibold text-navy">{account.qbo_account_type}</div>
            <div>{account.qbo_account_subtype}</div>
          </>
        )}
      </div>

      <div>
        <span
          className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{ backgroundColor: sec.bg, color: sec.color }}
        >
          {sec.label}
        </span>
      </div>

      <div className="text-xs text-ink-slate text-right">
        {totalUsage > 0 ? (
          <div title={`${account.usage.times_used_in_cleanups} cleanups, ${account.usage.times_used_in_rules} rules`}>
            <span className="font-bold text-navy">{totalUsage}</span> uses
          </div>
        ) : (
          <span className="text-ink-light italic">unused</span>
        )}
      </div>

      <RowActions
        editing={editing}
        canEdit={canEdit}
        saving={saving}
        onSave={onSave}
        onCancel={onCancel}
        onEdit={onEdit}
        onDelete={onDelete}
        extraActions={
          canEdit && !editing
            ? [
                {
                  icon: Plus,
                  label: "Add child",
                  onClick: onAddChild,
                  color: "text-teal",
                },
              ]
            : []
        }
      />
    </div>
  );
}

function ChildRow({
  account,
  isFirstChild,
  isLastChild,
  editing,
  editValues,
  setEditValues,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onMoveUp,
  onMoveDown,
  canEdit,
  saving,
}: {
  account: MasterAccount;
  isFirstChild: boolean;
  isLastChild: boolean;
  editing: boolean;
  editValues: Partial<MasterAccount>;
  setEditValues: (v: Partial<MasterAccount>) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canEdit: boolean;
  saving: boolean;
}) {
  const sec = SECTION_COLORS[account.section] || SECTION_COLORS.operating_expense;
  const totalUsage = account.usage.times_used_in_cleanups + account.usage.times_used_in_rules;

  return (
    <div className="grid items-start px-5 py-2.5 border-b border-gray-100 hover:bg-teal-lighter/40"
         style={{ gridTemplateColumns: "auto 2.5fr 1.5fr 1fr 0.8fr auto" }}>
      {canEdit ? (
        <div className="flex flex-col gap-0.5 mr-2 ml-6 mt-0.5">
          <button
            onClick={onMoveUp}
            disabled={isFirstChild}
            className="text-ink-light hover:text-navy disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move up"
          >
            <ArrowUp size={11} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLastChild}
            className="text-ink-light hover:text-navy disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move down"
          >
            <ArrowDown size={11} />
          </button>
        </div>
      ) : (
        <div className="w-8" />
      )}

      <div className="min-w-0 pl-2">
        {editing ? (
          <div className="space-y-1">
            <input
              type="text"
              value={editValues.account_name || ""}
              onChange={(e) => setEditValues({ ...editValues, account_name: e.target.value })}
              className="w-full px-2 py-1 border border-teal rounded text-sm font-semibold outline-none text-navy"
              autoFocus
            />
            <textarea
              value={editValues.notes || ""}
              onChange={(e) => setEditValues({ ...editValues, notes: e.target.value })}
              placeholder="Notes (optional)"
              rows={1}
              className="w-full px-2 py-1 border border-gray-200 rounded text-xs italic outline-none focus:border-teal text-ink-slate resize-none"
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs cursor-pointer text-navy">
                <input
                  type="checkbox"
                  checked={editValues.is_required ?? false}
                  onChange={(e) => setEditValues({ ...editValues, is_required: e.target.checked })}
                />
                Required
              </label>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-navy">{account.account_name}</span>
              {account.is_required && (
                <Star size={11} className="text-yellow-500 fill-yellow-500 flex-shrink-0" />
              )}
            </div>
            {account.notes && (
              <div className="text-xs italic mt-0.5 text-ink-slate line-clamp-1">
                {account.notes}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="text-xs">
        {editing ? (
          <div className="flex flex-col gap-1">
            <input
              type="text"
              value={editValues.qbo_account_type || ""}
              onChange={(e) => setEditValues({ ...editValues, qbo_account_type: e.target.value })}
              placeholder="QBO Type"
              className="px-2 py-1 border border-gray-200 rounded text-xs outline-none focus:border-teal text-navy"
            />
            <input
              type="text"
              value={editValues.qbo_account_subtype || ""}
              onChange={(e) => setEditValues({ ...editValues, qbo_account_subtype: e.target.value })}
              placeholder="QBO Subtype"
              className="px-2 py-1 border border-gray-200 rounded text-xs outline-none focus:border-teal text-navy"
            />
          </div>
        ) : (
          <div className="text-ink-slate">
            <div className="font-medium text-navy">{account.qbo_account_type}</div>
            <div>{account.qbo_account_subtype}</div>
          </div>
        )}
      </div>

      <div>
        <span
          className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{ backgroundColor: sec.bg, color: sec.color }}
        >
          {sec.label}
        </span>
        {account.tax_treatment?.rule && (
          <div className="text-[10px] text-ink-light mt-1" title={account.tax_treatment.note}>
            🏷 {account.tax_treatment.rule}
          </div>
        )}
      </div>

      <div className="text-xs text-ink-slate text-right">
        {totalUsage > 0 ? (
          <div title={`${account.usage.times_used_in_cleanups} cleanups, ${account.usage.times_used_in_rules} rules`}>
            <span className="font-bold text-navy">{totalUsage}</span> uses
          </div>
        ) : (
          <span className="text-ink-light italic">unused</span>
        )}
      </div>

      <RowActions
        editing={editing}
        canEdit={canEdit}
        saving={saving}
        onSave={onSave}
        onCancel={onCancel}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

function RowActions({
  editing,
  canEdit,
  saving,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  extraActions,
}: {
  editing: boolean;
  canEdit: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
  extraActions?: { icon: any; label: string; onClick: () => void; color: string }[];
}) {
  if (saving) {
    return (
      <div className="flex justify-end">
        <Loader2 size={14} className="animate-spin text-teal" />
      </div>
    );
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 justify-end">
        <button
          onClick={onSave}
          className="p-1.5 rounded-md text-green-600 hover:bg-green-50"
          title="Save"
        >
          <Save size={14} />
        </button>
        <button
          onClick={onCancel}
          className="p-1.5 rounded-md text-ink-slate hover:bg-gray-100"
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  if (!canEdit) return <div />;

  return (
    <div className="flex items-center gap-1 justify-end">
      {extraActions?.map((a) => {
        const Icon = a.icon;
        return (
          <button
            key={a.label}
            onClick={a.onClick}
            className={`p-1.5 rounded-md hover:bg-teal-light ${a.color}`}
            title={a.label}
          >
            <Icon size={13} />
          </button>
        );
      })}
      <button
        onClick={onEdit}
        className="p-1.5 rounded-md text-ink-slate hover:bg-gray-100 hover:text-navy"
        title="Edit"
      >
        <Edit2 size={13} />
      </button>
      <button
        onClick={onDelete}
        className="p-1.5 rounded-md text-ink-slate hover:bg-red-50 hover:text-red-600"
        title="Delete"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
