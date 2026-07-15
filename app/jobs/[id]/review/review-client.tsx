"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, ChevronDown, Edit2, Trash2, Flag, Check,
  Loader2, Building2, GitMerge, Search, ChevronRight, RefreshCcw,
} from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

// The generated DB types don't include 'retype' until they're regenerated
// after migration 119 — widen locally so the new action renders type-safely.
type ActionRow = Database["public"]["Tables"]["coa_actions"]["Row"];
type Action = Omit<ActionRow, "action"> & { action: ActionRow["action"] | "retype" };
type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

interface MasterAccount {
  account_name: string;
  parent_account_name: string | null;
  // Nullable to match the master_coa column type returned by Supabase
  // (the merge of the onboarding/discovery branches surfaced this as a
  // new type error otherwise). Only ever read for display, never as a
  // strict boolean, so null is harmless.
  is_parent: boolean | null;
  section: string | null;
  sort_order: number | null;
}

// ── Section metadata ──────────────────────────────────────────────────────────

const SECTION_ORDER: Record<string, number> = {
  revenue:           1,
  cogs:              2,
  operating_expense: 3,
  other_income:      4,
  asset:             5,
  liability:         6,
  equity:            7,
  uncategorized:     99,
};

const SECTION_LABELS: Record<string, string> = {
  revenue:           "Revenue",
  cogs:              "Cost of Goods Sold",
  operating_expense: "Operating Expenses",
  other_income:      "Other Income / Expense",
  asset:             "Assets",
  liability:         "Liabilities",
  equity:            "Equity",
  uncategorized:     "Uncategorized",
};

const SECTION_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  revenue:           { bg: "#F0FDF4", text: "#166534", border: "#BBF7D0" },
  cogs:              { bg: "#FFF7ED", text: "#9A3412", border: "#FED7AA" },
  operating_expense: { bg: "#EFF6FF", text: "#1E3A8A", border: "#BFDBFE" },
  other_income:      { bg: "#F5F3FF", text: "#4C1D95", border: "#DDD6FE" },
  asset:             { bg: "#ECFDF5", text: "#065F46", border: "#A7F3D0" },
  liability:         { bg: "#FEF2F2", text: "#991B1B", border: "#FECACA" },
  equity:            { bg: "#FFFBEB", text: "#92400E", border: "#FDE68A" },
  uncategorized:     { bg: "#F9FAFB", text: "#6B7280", border: "#E5E7EB" },
};

// ── Grouped rendering helpers ─────────────────────────────────────────────────

interface PositionedAction {
  action: Action;
  section: string;
  sectionOrder: number;
  sortOrder: number;
  subsection: string | null;
}

function getActionPosition(
  action: Action,
  masterByName: Map<string, MasterAccount>
): PositionedAction {
  // For keep: look up current name. For rename/merge: look up target. For flag/delete: uncategorized.
  const lookupName =
    action.action === "keep"
      ? action.current_name
      : action.new_name || action.ai_suggested_target;

  const master = lookupName
    ? masterByName.get(lookupName.trim().toLowerCase())
    : undefined;

  const section = master?.section || "uncategorized";
  return {
    action,
    section,
    sectionOrder: SECTION_ORDER[section] ?? 99,
    sortOrder: master?.sort_order ?? 9999,
    subsection: master?.parent_account_name ?? null,
  };
}

interface SubsectionGroup {
  name: string | null;
  rows: PositionedAction[];
}

interface SectionGroup {
  key: string;
  label: string;
  subsections: SubsectionGroup[];
}

function groupActions(
  actions: Action[],
  masterByName: Map<string, MasterAccount>
): SectionGroup[] {
  const positioned = actions.map((a) => getActionPosition(a, masterByName));

  // Sort: section order → sort_order → current_name alpha
  positioned.sort((a, b) => {
    if (a.sectionOrder !== b.sectionOrder) return a.sectionOrder - b.sectionOrder;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (a.action.current_name || "").localeCompare(b.action.current_name || "");
  });

  // Group by section → subsection
  const sectionMap = new Map<string, Map<string, PositionedAction[]>>();
  for (const p of positioned) {
    if (!sectionMap.has(p.section)) sectionMap.set(p.section, new Map());
    const subKey = p.subsection || "__none__";
    const sub = sectionMap.get(p.section)!;
    if (!sub.has(subKey)) sub.set(subKey, []);
    sub.get(subKey)!.push(p);
  }

  const result: SectionGroup[] = [];
  for (const [sectionKey, subsMap] of sectionMap) {
    const subsections: SubsectionGroup[] = [];
    for (const [subKey, rows] of subsMap) {
      subsections.push({ name: subKey === "__none__" ? null : subKey, rows });
    }
    result.push({
      key: sectionKey,
      label: SECTION_LABELS[sectionKey] || sectionKey,
      subsections,
    });
  }
  return result;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ReviewClient({
  jobId,
  clientLink,
  initialActions,
  masterAccounts,
}: {
  jobId: string;
  clientLink: ClientLink;
  initialActions: Action[];
  masterAccounts: MasterAccount[];
}) {
  const router = useRouter();
  const [actions, setActions] = useState(initialActions);
  const [filter, setFilter] = useState<"all" | "rename" | "merge" | "delete" | "flag" | "keep" | "create" | "retype">("all");
  const [executing, setExecuting] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // Count of executed actions — used in the re-analyze confirm dialog so
  // the bookkeeper knows what survives the refresh.
  const executedCount = actions.filter((a) => a.executed === true).length;

  /** Re-run /analyze to refresh AI suggestions. The server route deletes
   *  unexecuted actions before inserting the fresh batch (the dedup fix
   *  from #76), so the bookkeeper gets a clean slate of new suggestions
   *  while their already-executed QBO writes stay intact. */
  async function handleReanalyze() {
    const proceed = confirm(
      `Re-analyze ${clientLink.client_name}'s COA?\n\n` +
        `• AI re-runs against the current QBO state — fresh suggestions.\n` +
        `• Unconfirmed actions (rename / merge / delete / keep / flag) ` +
        `will be replaced.\n` +
        (executedCount > 0
          ? `• ${executedCount} action${executedCount === 1 ? "" : "s"} already executed in QBO will be preserved.\n`
          : "") +
        `\nUse this if the QBO COA changed since the last analysis, OR if you ` +
        `want a fresh pass after manual edits.`
    );
    if (!proceed) return;
    setReanalyzing(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/analyze`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Re-analyze failed: ${body.error || `HTTP ${res.status}`}`);
        setReanalyzing(false);
        return;
      }
      // Hard refresh so the server-rendered page re-fetches actions in
      // their new (deduped) state. Avoids stale-state edge cases vs a
      // client-side refetch.
      router.refresh();
    } catch (e: any) {
      alert(`Re-analyze failed: ${e?.message || "unknown"}`);
      setReanalyzing(false);
    }
  }

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // Build master lookup once
  const masterByName = new Map(
    masterAccounts.map((m) => [m.account_name.trim().toLowerCase(), m])
  );

  const counts = {
    rename: actions.filter((a) => a.action === "rename").length,
    retype: actions.filter((a) => a.action === "retype").length,
    merge:  actions.filter((a) => a.action === "merge").length,
    delete: actions.filter((a) => a.action === "delete").length,
    keep:   actions.filter((a) => a.action === "keep").length,
    flag:   actions.filter((a) => a.action === "flag").length,
    create: actions.filter((a) => a.action === "create").length,
  };

  const filtered = filter === "all" ? actions : actions.filter((a) => a.action === filter);
  const sectionGroups = groupActions(filtered, masterByName);

  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function updateAction(
    actionId: string,
    newAction: Action["action"],
    newTarget?: string,
    flaggedReason?: string
  ) {
    // One-rename-per-target guard (Mike, 2026-07-15): QBO can't hold two
    // accounts with the same name. If this row is being set to "rename" toward
    // a name that ANOTHER row is already renaming to, this row must "merge"
    // into that target instead — never a second rename to the same name.
    let effAction = newAction;
    if (newAction === "rename") {
      const target = (
        (newTarget !== undefined
          ? newTarget
          : actions.find((a) => a.id === actionId)?.new_name) || ""
      )
        .trim()
        .toLowerCase();
      if (target) {
        const clashes = actions.some(
          (a) =>
            a.id !== actionId &&
            a.action === "rename" &&
            (a.new_name || "").trim().toLowerCase() === target
        );
        if (clashes) effAction = "merge";
      }
    }

    setActions((prev) =>
      prev.map((a) =>
        a.id === actionId
          ? {
              ...a,
              action: effAction,
              new_name: newTarget !== undefined ? newTarget : a.new_name,
              ai_suggested_target: newTarget || a.ai_suggested_target,
              flagged_reason: flaggedReason !== undefined ? flaggedReason : a.flagged_reason,
              bookkeeper_override: true,
            }
          : a
      )
    );

    await supabase
      .from("coa_actions")
      .update({
        // This call site's Update generic already resolved to `never` in the
        // typecheck baseline; 'retype' additionally isn't in the generated
        // enum until types regenerate post-migration-119. Assert the payload.
        action: effAction,
        ...(newTarget !== undefined && { new_name: newTarget || null }),
        ...(newTarget && { ai_suggested_target: newTarget }),
        ...(flaggedReason !== undefined && { flagged_reason: flaggedReason }),
        bookkeeper_override: true,
      } as never)
      .eq("id", actionId);
  }

  async function approveAndExecute() {
    if (!confirm(`Execute this cleanup on ${clientLink.client_name}? This will modify QBO + Double.`)) return;
    setExecuting(true);

    let res: Response;
    let result: any = {};
    try {
      res = await fetch(`/api/jobs/${jobId}/execute`, { method: "POST" });
      result = await res.json().catch(() => ({}));
    } catch (err: any) {
      setExecuting(false);
      alert(`Network error: ${err?.message || err}`);
      return;
    }

    setExecuting(false);
    if (res.ok && (result.started || result.message)) {
      router.push(`/jobs/${jobId}/execute`);
    } else {
      const msg = result.error || (Array.isArray(result.errors) ? result.errors.join(", ") : null) || `HTTP ${res.status}`;
      alert(`Could not start execution: ${msg}`);
    }
  }

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-6 gap-3 mb-5">
        {[
          { label: "Rename",    value: counts.rename, color: "#2D7A75" },
          { label: "Merge",     value: counts.merge,  color: "#7C3AED" },
          { label: "Delete",    value: counts.delete, color: "#DC2626" },
          { label: "Keep",      value: counts.keep,   color: "#475569" },
          { label: "Flagged",   value: counts.flag,   color: "#F59E0B" },
          { label: "Create New",value: counts.create, color: "#10B981" },
        ].map((s) => (
          <div key={s.label} className="px-4 py-3 rounded-lg bg-white border border-gray-200">
            <div className="text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">{s.label}</div>
            <div className="text-xl font-bold" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs + Re-analyze action */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {(["all", "rename", "retype", "merge", "delete", "flag", "keep", "create"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors capitalize ${
              filter === f
                ? "bg-navy text-white border border-navy"
                : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
            }`}
          >
            {f} ({f === "all" ? actions.length : counts[f as keyof typeof counts]})
          </button>
        ))}
        {/* Re-analyze — refreshes AI suggestions from the current QBO state.
            Server-side dedup (#76) ensures this doesn't pile new rows on
            top of the old; unconfirmed suggestions get replaced cleanly. */}
        <button
          onClick={handleReanalyze}
          disabled={reanalyzing || executing}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold bg-white text-ink-slate border border-gray-200 hover:border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Runs analysis again. Executed actions stay, others get replaced."
        >
          {reanalyzing ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCcw size={13} />
          )}
          {reanalyzing ? "Refreshing…" : "Refresh AI Suggestions"}
        </button>
      </div>

      {/* Column headers */}
      <div
        className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border border-gray-200 rounded-t-xl"
        style={{ gridTemplateColumns: "1.4fr 1.4fr 1.6fr 0.9fr 1.1fr" }}
      >
        <div>Current Account</div>
        <div>AI Suggestion</div>
        <div>Align to Template</div>
        <div>Confidence</div>
        <div>Action</div>
      </div>

      {/* Section-grouped rows */}
      <div className="rounded-b-xl overflow-hidden border border-t-0 border-gray-200 mb-6">
        {sectionGroups.length === 0 && (
          <p className="text-sm text-ink-slate py-12 text-center bg-white">No actions match this filter.</p>
        )}

        {sectionGroups.map((section) => {
          const colors = SECTION_COLORS[section.key] || SECTION_COLORS.uncategorized;
          const collapsed = collapsedSections.has(section.key);
          const rowCount = section.subsections.reduce((n, s) => n + s.rows.length, 0);

          return (
            <div key={section.key}>
              {/* Section header */}
              <button
                onClick={() => toggleSection(section.key)}
                className="w-full flex items-center gap-2 px-5 py-2.5 text-left border-b border-t"
                style={{
                  backgroundColor: colors.bg,
                  borderColor: colors.border,
                  color: colors.text,
                }}
              >
                <ChevronRight
                  size={14}
                  className="flex-shrink-0 transition-transform"
                  style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                />
                <span className="font-bold text-sm uppercase tracking-wider">{section.label}</span>
                <span
                  className="ml-1.5 text-xs font-semibold px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: colors.border, color: colors.text }}
                >
                  {rowCount}
                </span>
              </button>

              {!collapsed && section.subsections.map((sub) => (
                <div key={sub.name || "__none__"}>
                  {/* Subsection header */}
                  {sub.name && (
                    <div
                      className="px-7 py-1.5 text-xs font-semibold text-ink-slate border-b border-gray-100 italic"
                      style={{ backgroundColor: colors.bg + "80" }}
                    >
                      {sub.name}
                    </div>
                  )}

                  {/* Account rows */}
                  {sub.rows.map((p) => (
                    <ActionRow
                      key={p.action.id}
                      action={p.action}
                      masterAccounts={masterAccounts}
                      onUpdate={updateAction}
                    />
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="flex justify-between items-center">
        <button
          onClick={() => router.back()}
          className="text-sm font-semibold text-ink-slate hover:text-navy"
        >
          ← Back to Dashboard
        </button>
        <div className="flex gap-3">
          <button
            onClick={approveAndExecute}
            disabled={executing}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
          >
            {executing ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
            {executing ? "Executing..." : "Approve & Execute"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Action row ────────────────────────────────────────────────────────────────

function ActionRow({
  action,
  masterAccounts,
  onUpdate,
}: {
  action: Action;
  masterAccounts: MasterAccount[];
  onUpdate: (id: string, newAction: Action["action"], newTarget?: string, flaggedReason?: string) => void;
}) {
  const [showMenu, setShowMenu] = useState(false);

  const actionConfig: Record<string, { color: string; bg: string; label: string; icon: any }> = {
    keep:   { color: "#475569", bg: "#F1F5F9", label: "Keep",       icon: Check     },
    rename: { color: "#2D7A75", bg: "#E8F2F0", label: "Rename",     icon: Edit2     },
    merge:  { color: "#7C3AED", bg: "#EDE9FE", label: "Merge into", icon: GitMerge  },
    delete: { color: "#DC2626", bg: "#FEE2E2", label: "Delete",     icon: Trash2    },
    flag:   { color: "#F59E0B", bg: "#FEF3C7", label: "Flag",       icon: Flag      },
    create: { color: "#10B981", bg: "#D1FAE5", label: "Create",     icon: Building2 },
    retype: { color: "#0891B2", bg: "#CFFAFE", label: "Fix Type",   icon: Building2 },
  };
  const cfg = actionConfig[action.action] ?? actionConfig.flag;
  const Icon = cfg.icon;
  const confidencePct = Math.round((action.ai_confidence || 0) * 100);
  const currentTarget = action.new_name || action.ai_suggested_target || "";
  const isDeleteOrKeep = action.action === "delete" || action.action === "keep" || action.action === "retype";

  function handleTargetChange(selectedTarget: string) {
    if (selectedTarget === "__uncategorized__") {
      onUpdate(action.id, "flag", "", "Uncategorized — no master account match identified");
      return;
    }
    const newAction: Action["action"] =
      action.action === "merge" ? "merge" : "rename";
    onUpdate(action.id, newAction, selectedTarget);
  }

  return (
    <div
      className="grid items-center px-5 py-3.5 hover:bg-teal-lighter transition-colors border-b border-gray-100 bg-white"
      style={{ gridTemplateColumns: "1.4fr 1.4fr 1.6fr 0.9fr 1.1fr" }}
    >
      {/* Current Account */}
      <div className="pl-2">
        <div className="font-semibold text-sm text-navy">
          {action.current_name || (action.action === "create" ? `(New) ${action.new_name}` : "—")}
        </div>
        {action.current_type && (
          <div className="text-xs mt-0.5 text-ink-slate">{action.current_type}</div>
        )}
      </div>

      {/* AI Suggestion */}
      <div className="text-sm pr-2">
        {action.action === "retype" ? (
          <div className="text-xs">
            <span className="font-semibold" style={{ color: "#0891B2" }}>
              {action.current_type || "?"}{action.current_subtype ? `/${action.current_subtype}` : ""} → {action.new_type}{action.new_subtype ? `/${action.new_subtype}` : ""}
            </span>
          </div>
        ) : action.action === "merge" && action.new_name ? (
          <div className="flex items-center gap-1.5">
            <GitMerge size={13} className="text-purple-600 flex-shrink-0" />
            <span className="font-semibold text-purple-700 text-xs">Merge into {action.new_name}</span>
          </div>
        ) : action.new_name ? (
          <div className="flex items-center gap-1.5">
            <ArrowRight size={13} className="text-teal flex-shrink-0" />
            <span className="font-semibold text-navy">{action.new_name}</span>
          </div>
        ) : null}
        {action.ai_reasoning && (
          <div className="text-xs mt-0.5 italic text-ink-slate leading-tight">{action.ai_reasoning}</div>
        )}
        {action.action === "flag" && action.flagged_reason && (
          <div className="text-xs mt-0.5 text-amber-600 leading-tight">{action.flagged_reason}</div>
        )}
      </div>

      {/* Map to Master */}
      <div className="pr-3">
        {isDeleteOrKeep || action.action === "create" ? (
          <span className="text-xs text-ink-light italic">—</span>
        ) : (
          <MasterAccountSelect
            value={currentTarget}
            masterAccounts={masterAccounts}
            onChange={handleTargetChange}
            isMerge={action.action === "merge"}
          />
        )}
      </div>

      {/* Confidence */}
      <div>
        <span
          className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold"
          style={{
            color:           confidencePct >= 90 ? "#10B981" : confidencePct >= 70 ? "#F59E0B" : "#DC2626",
            backgroundColor: confidencePct >= 90 ? "#D1FAE5" : confidencePct >= 70 ? "#FEF3C7" : "#FEE2E2",
          }}
        >
          {confidencePct}%
        </span>
      </div>

      {/* Action dropdown */}
      <div className="relative">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-sm font-semibold bg-white border border-gray-200 text-navy"
        >
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold"
            style={{ color: cfg.color, backgroundColor: cfg.bg }}
          >
            <Icon size={12} />
            {cfg.label}
          </span>
          <ChevronDown size={14} className="ml-auto text-ink-light" />
        </button>

        {showMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
            <div className="absolute right-0 top-full mt-1 rounded-lg shadow-lg z-20 overflow-hidden bg-white border border-gray-200 min-w-48">
              {(["keep", "rename", "merge", "delete", "flag"] as const).map((opt) => {
                const optCfg = actionConfig[opt];
                const OptIcon = optCfg.icon;
                const disabled = opt === "delete" && (action.transaction_count || 0) > 0;
                return (
                  <button
                    key={opt}
                    onClick={() => {
                      if (!disabled) {
                        onUpdate(
                          action.id,
                          opt,
                          (opt === "rename" || opt === "merge")
                            ? (action.ai_suggested_target || action.new_name || undefined)
                            : undefined
                        );
                        setShowMenu(false);
                      }
                    }}
                    disabled={disabled}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-teal-lighter disabled:opacity-40 disabled:cursor-not-allowed text-navy"
                  >
                    <OptIcon size={14} />
                    {optCfg.label}
                    {disabled && <span className="text-xs ml-auto text-ink-slate">has txns</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Master account searchable dropdown ───────────────────────────────────────

function MasterAccountSelect({
  value,
  masterAccounts,
  onChange,
  isMerge,
}: {
  value: string;
  masterAccounts: MasterAccount[];
  onChange: (val: string) => void;
  isMerge: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredMaster = masterAccounts.filter(
    (m) =>
      m.account_name.toLowerCase().includes(search.toLowerCase()) ||
      (m.section || "").toLowerCase().includes(search.toLowerCase()) ||
      (m.parent_account_name || "").toLowerCase().includes(search.toLowerCase())
  );

  // Group by section for display
  const grouped: Record<string, MasterAccount[]> = {};
  for (const m of filteredMaster) {
    const sec = SECTION_LABELS[m.section || ""] || m.section || "Other";
    if (!grouped[sec]) grouped[sec] = [];
    grouped[sec].push(m);
  }

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const isUncategorized = !value;
  const borderColor = isUncategorized ? "#D1D5DB" : isMerge ? "#7C3AED" : "#2D7A75";
  const displayLabel = value || (isMerge ? "Select merge target…" : "Select master account…");

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-white hover:bg-gray-50 text-left"
        style={{ borderColor, color: isUncategorized ? "#9CA3AF" : "#0F1F2E" }}
      >
        <span className="flex-1 truncate">{displayLabel}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-ink-light" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-72 rounded-lg shadow-xl bg-white border border-gray-200 overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
            <Search size={13} className="text-ink-light flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts..."
              className="flex-1 text-xs outline-none bg-transparent text-navy placeholder:text-ink-light"
            />
          </div>

          <div className="max-h-72 overflow-y-auto">
            {/* Uncategorized — always pinned at top */}
            {!search && (
              <div>
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-light bg-gray-50 sticky top-0">
                  Special
                </div>
                <button
                  onClick={() => { onChange("__uncategorized__"); setOpen(false); setSearch(""); }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-amber-50 transition-colors ${
                    !value ? "font-semibold text-amber-700 bg-amber-50" : "text-amber-700"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Flag size={11} />
                    Uncategorized
                  </span>
                  <span className="text-[10px] text-amber-500 mt-0.5 block">
                    Flag for manual placement
                  </span>
                </button>
              </div>
            )}

            {/* Master accounts grouped by section */}
            {Object.keys(grouped).length === 0 && search ? (
              <div className="px-3 py-4 text-xs text-center text-ink-slate">No matches</div>
            ) : (
              Object.entries(grouped).map(([sectionLabel, accounts]) => (
                <div key={sectionLabel}>
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-light bg-gray-50 sticky top-0">
                    {sectionLabel}
                  </div>
                  {accounts.map((m) => (
                    <button
                      key={m.account_name}
                      onClick={() => { onChange(m.account_name); setOpen(false); setSearch(""); }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-teal-lighter transition-colors ${
                        value === m.account_name ? "font-semibold text-teal bg-teal-lighter" : "text-navy"
                      }`}
                    >
                      <span>{m.account_name}</span>
                      {m.parent_account_name && (
                        <span className="ml-1.5 text-ink-light">· {m.parent_account_name}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
