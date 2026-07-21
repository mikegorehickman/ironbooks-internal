"use client";

import { useState, useEffect } from "react";
import { Loader2, Search, AlertTriangle, CheckCircle2, Wrench, Clock } from "lucide-react";
import { LIFECYCLE_META, type LifecycleStatus } from "@/lib/client-lifecycle";

interface ClientRow {
  id: string;
  client_name: string;
  jurisdiction: string | null;
}

/** Normalize a client's jurisdiction to "CA" or "US" (default US). */
function regionOf(c: ClientRow): "CA" | "US" {
  return String(c.jurisdiction || "US").toUpperCase().startsWith("CA") ? "CA" : "US";
}

interface MergeProposal {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  action: "merge" | "leave";
  targetId: string | null;
  targetName: string | null;
  confident: boolean;
  reason?: string;
  /** Inactive account still carrying a P&L balance (retired without drain) —
   *  the merge reactivates, drains, and re-retires it. */
  deleted?: boolean;
  amount?: number;
}

interface Drift {
  totalActive: number;
  matched: number;
  wrongType: { id: string; name: string; currentType: string; masterType: string }[];
  nonMaster: { id: string; name: string; type: string }[];
  missingRequired: string[];
  wrongParent?: { id: string; name: string; currentParent: string | null; masterParent: string | null }[];
  conformancePct: number;
  mergeTargets?: { id: string; name: string }[];
  mergeProposals?: MergeProposal[];
  aiSuggestions?: boolean;
}

interface RowState {
  status: "idle" | "scanning" | "done" | "error" | "reauth";
  drift: Drift | null;
  applying?: boolean;
  fixMsg?: string;
  message?: string;
  scannedAt?: string | null;
  scannedBy?: string | null;
}

const EMPTY: RowState = { status: "idle", drift: null };

/** A client is DONE when a scan found fewer than this many actionable issues. */
const DONE_THRESHOLD = 4;
/** Cached scans older than this read as "stale" (re-scan suggested). */
const STALE_DAYS = 30;
/** Owner-only batch: how many clients' Fix-all pipelines run concurrently. */
const BATCH_CONCURRENCY = 3;

function scoreColor(pct: number) {
  if (pct >= 90) return "text-emerald-700";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

/** Actionable issue count — matches "Fix all (N)": re-types + missing creates
 *  + re-nests + confident merges. Correctly-left-alone accounts don't count. */
function issueCountOf(d: Drift | null): number {
  if (!d) return 0;
  const merges = (d.mergeProposals || []).filter((p) => p.action === "merge").length;
  return d.wrongType.length + d.missingRequired.length + (d.wrongParent?.length || 0) + merges;
}

function isDone(r: RowState | undefined): boolean {
  return !!r && r.status === "done" && !!r.drift && issueCountOf(r.drift) < DONE_THRESHOLD;
}

/** $ stranded on retired ("deleted") accounts still carrying a balance. */
function strandedOf(d: Drift | null): number {
  if (!d) return 0;
  return (d.mergeProposals || []).filter((p) => p.deleted).reduce((a, p) => a + Math.abs(p.amount || 0), 0);
}

/** How many retired accounts still carry a balance on this client. */
function deletedCountOf(d: Drift | null): number {
  if (!d) return 0;
  return (d.mergeProposals || []).filter((p) => p.deleted).length;
}

function daysSince(iso?: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function isStale(iso?: string | null): boolean {
  const d = daysSince(iso);
  return d != null && d > STALE_DAYS;
}

function fmtWhen(iso?: string | null): string {
  const d = daysSince(iso);
  if (d == null) return "";
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < STALE_DAYS) return `${d}d ago`;
  return new Date(iso as string).toLocaleDateString();
}

export function CoaAuditClient({
  clients,
  initialScans = {},
  initialStages = {},
  isOwner = false,
  canFix = true,
}: {
  clients: ClientRow[];
  initialScans?: Record<string, { drift: Drift; scannedAt: string; scannedBy: string | null }>;
  /** Per-client cleanup-flow stage (deriveLifecycleStatus), for the Stage column. */
  initialStages?: Record<string, LifecycleStatus>;
  /** Owner-only (Mike): unlocks the multi-select batch Fix-all runner. */
  isOwner?: boolean;
  /** Whether this user can run fixes/merges (viewers are read-only). */
  canFix?: boolean;
}) {
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(clients.map((c) => {
      const s = initialScans[c.id];
      return [c.id, s
        ? { status: "done" as const, drift: s.drift, scannedAt: s.scannedAt, scannedBy: s.scannedBy }
        : { ...EMPTY }];
    }))
  );
  // Seed fix selections from the cached scans once on mount, so "Fix all" and
  // "review & fix" work straight from cache without forcing a re-scan.
  useEffect(() => {
    for (const c of clients) {
      const d = initialScans[c.id]?.drift;
      if (d) seedSelection(c.id, d);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [region, setRegion] = useState<"all" | "CA" | "US">("all");
  // Per-client selection of which fixes to apply.
  const [retypeSel, setRetypeSel] = useState<Record<string, Set<string>>>({});
  const [createSel, setCreateSel] = useState<Record<string, Set<string>>>({});
  const [reparentSel, setReparentSel] = useState<Record<string, Set<string>>>({});
  // Merge: chosen target per source account (clientId → sourceId → targetId),
  // in-flight source, and per-source result message.
  const [mergeSel, setMergeSel] = useState<Record<string, Record<string, string>>>({});
  const [mergeBusy, setMergeBusy] = useState<string | null>(null);
  const [mergeMsg, setMergeMsg] = useState<Record<string, string>>({});
  // Owner-only batch: which clients are ticked, and batch progress text.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMsg, setBatchMsg] = useState<string>("");

  const visibleClients = clients.filter((c) => region === "all" || regionOf(c) === region);
  const caCount = clients.filter((c) => regionOf(c) === "CA").length;
  const usCount = clients.length - caCount;

  function patch(id: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  // When drift arrives, default every fixable item to selected + pre-fill each
  // merge's target with the suggestion.
  function seedSelection(id: string, d: Drift) {
    setRetypeSel((prev) => ({ ...prev, [id]: new Set(d.wrongType.map((w) => w.id)) }));
    setCreateSel((prev) => ({ ...prev, [id]: new Set(d.missingRequired) }));
    setReparentSel((prev) => ({ ...prev, [id]: new Set((d.wrongParent || []).map((w) => w.id)) }));
    const m: Record<string, string> = {};
    for (const p of d.mergeProposals || []) if (p.action === "merge") m[p.sourceId] = p.targetId || "";
    setMergeSel((prev) => ({ ...prev, [id]: m }));
  }

  async function applyMerge(clientId: string, clientName: string, p: MergeProposal, targets: { id: string; name: string }[]) {
    const targetId = mergeSel[clientId]?.[p.sourceId] || "";
    if (!targetId) return;
    const targetName = targets.find((t) => t.id === targetId)?.name || "the target";
    if (!confirm(`Merge "${p.sourceName}" → "${targetName}" for ${clientName}?\n\nThis moves ALL year-to-date transactions (including already-closed months) onto "${targetName}" and deactivates "${p.sourceName}". This rewrites the books.`)) return;
    setMergeBusy(p.sourceId);
    setMergeMsg((m) => ({ ...m, [p.sourceId]: "" }));
    try {
      const postMerge = (allowCompleted: boolean) =>
        fetch("/api/admin/coa-audit/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: clientId, source_account_id: p.sourceId, target_account_id: targetId, ...(allowCompleted ? { allow_completed: true } : {}) }),
        });
      let res = await postMerge(false);
      let data = await res.json();
      if (res.status === 409 && data.error === "cleanup_complete") {
        if (!confirm(`⚠ ${data.message}\n\nMerge anyway?`)) { setMergeMsg((m) => ({ ...m, [p.sourceId]: "skipped — cleanup-complete" })); return; }
        res = await postMerge(true);
        data = await res.json();
      }
      if (data.reauth) { setMergeMsg((m) => ({ ...m, [p.sourceId]: "QBO reconnect needed" })); return; }
      if (data.tooLarge) { setMergeMsg((m) => ({ ...m, [p.sourceId]: data.error })); return; }
      if (data.ok === false) { setMergeMsg((m) => ({ ...m, [p.sourceId]: data.error || "merge failed" })); return; }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const parts: string[] = [];
      if (data.linesMoved) parts.push(`${data.linesMoved} txn(s) moved`);
      if ((data.amountMoved || 0) > 0 && data.jesPosted) parts.push(`$${Math.round(data.amountMoved).toLocaleString()} swept via ${data.jesPosted} JE${data.jesPosted === 1 ? "" : "s"}`);
      if (!data.linesMoved && !((data.amountMoved || 0) > 0)) parts.push("nothing to move");
      if (data.childrenDetached > 0) parts.push(`${data.childrenDetached} sub-account(s) re-parented`);
      if (data.itemsRepointed > 0) parts.push(`${data.itemsRepointed} item(s) re-pointed`);
      if (data.inactivated) parts.push("source retired");
      if (data.failures?.length) parts.push(`${data.failures.length} failed`);
      setMergeMsg((m) => ({ ...m, [p.sourceId]: parts.join(" · ") }));
      // Re-scan to refresh conformance + drop the merged account.
      await scan(clientId);
    } catch (e: any) {
      setMergeMsg((m) => ({ ...m, [p.sourceId]: e.message }));
    } finally {
      setMergeBusy(null);
    }
  }

  async function scan(id: string): Promise<Drift | null> {
    patch(id, { status: "scanning", message: undefined, fixMsg: undefined });
    try {
      const res = await fetch("/api/admin/coa-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: id }),
      });
      const data = await res.json();
      if (data.reauth) { patch(id, { status: "reauth" }); return null; }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      patch(id, {
        status: "done", drift: data,
        scannedAt: data.scanned_at || new Date().toISOString(),
        scannedBy: data.scanned_by_name ?? null,
      });
      seedSelection(id, data);
      return data as Drift;
    } catch (e: any) {
      patch(id, { status: "error", message: e.message });
      return null;
    }
  }

  async function scanAll() {
    setBusy(true);
    for (const c of visibleClients) {
      // eslint-disable-next-line no-await-in-loop
      await scan(c.id);
    }
    setBusy(false);
  }

  // Incremental scan: only clients never scanned or whose cached scan is stale.
  // The whole point of persistence — no re-scanning what's already fresh.
  async function scanStale() {
    setBusy(true);
    for (const c of visibleClients) {
      const r = rows[c.id];
      const fresh = r?.status === "done" && !!r.scannedAt && !isStale(r.scannedAt);
      if (fresh) continue;
      // eslint-disable-next-line no-await-in-loop
      await scan(c.id);
    }
    setBusy(false);
  }

  async function applyFix(id: string, clientName: string) {
    const retype = [...(retypeSel[id] || [])];
    const create = [...(createSel[id] || [])];
    const reparent = [...(reparentSel[id] || [])];
    if (retype.length === 0 && create.length === 0 && reparent.length === 0) return;
    if (!confirm(`Apply to ${clientName}'s live QuickBooks: ${retype.length} account re-type(s) + ${create.length} new account(s) + ${reparent.length} re-nest(s)? This re-writes the chart. (Merges/renames of other accounts are handled separately in the reviewed cleanup.)`)) return;
    patch(id, { applying: true, fixMsg: undefined });
    try {
      const post = (allowCompleted: boolean) =>
        fetch("/api/admin/coa-audit/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: id, retype_account_ids: retype, create_account_names: create, reparent_account_ids: reparent, ...(allowCompleted ? { allow_completed: true } : {}) }),
        });
      let res = await post(false);
      let data = await res.json();
      // Cleanup-complete guard: an individual reviewed fix may override after an
      // explicit confirm; the "Fix all" batch runner does NOT (see runAllFixes).
      if (res.status === 409 && data.error === "cleanup_complete") {
        if (!confirm(`⚠ ${data.message}\n\nApply anyway?`)) { patch(id, { applying: false, fixMsg: "skipped — file is cleanup-complete" }); return; }
        res = await post(true);
        data = await res.json();
      }
      if (data.reauth) { patch(id, { applying: false, fixMsg: "QBO needs reconnect" }); return; }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const parts: string[] = [];
      if (data.retyped?.length) parts.push(`${data.retyped.length} re-typed`);
      if (data.created?.length) parts.push(`${data.created.length} created`);
      if (data.renested?.length) parts.push(`${data.renested.length} re-nested`);
      if (data.failed?.length) parts.push(`${data.failed.length} failed`);
      patch(id, { applying: false, status: "done", drift: data.drift, fixMsg: parts.join(" · ") || "no changes" });
      if (data.drift) seedSelection(id, data.drift);
    } catch (e: any) {
      patch(id, { applying: false, fixMsg: e.message });
    }
  }

  // Count of actionable fixes for a client from its current drift + selections
  // (mirrors the row's "Fix all (N)" badge). Used to gate batch selection.
  function fixCountOf(id: string): number {
    const d = rows[id]?.drift;
    if (!d) return 0;
    const fixable = d.wrongType.length + d.missingRequired.length + (d.wrongParent?.length || 0);
    const mergeable = (d.mergeProposals || []).filter((p) => p.action === "merge" && (mergeSel[id]?.[p.sourceId] || p.targetId)).length;
    return fixable + mergeable;
  }

  // The full Fix-all pipeline for ONE client — NO confirmation prompt. Applies
  // every re-type / missing-create / re-nest, re-scans, then runs each merge
  // that has a target. Updates the row's inline status as it goes and returns a
  // one-line summary. Shared by the single button and the owner batch runner.
  async function runAllFixes(id: string): Promise<string> {
    const d = rows[id]?.drift;
    if (!d) return "not scanned";
    const retype = d.wrongType.map((w) => w.id);
    const create = [...d.missingRequired];
    const reparent = (d.wrongParent || []).map((w) => w.id);
    const mergeList = (d.mergeProposals || [])
      .filter((p) => p.action === "merge")
      .map((p) => ({ p, targetId: mergeSel[id]?.[p.sourceId] || p.targetId || "" }))
      .filter((x) => x.targetId);
    const mergesTotal = (d.mergeProposals || []).filter((p) => p.action === "merge").length;
    const skipped = mergesTotal - mergeList.length;
    if (retype.length + create.length + reparent.length + mergeList.length === 0) {
      patch(id, { applying: false, fixMsg: "nothing to fix" });
      return "nothing to fix";
    }
    patch(id, { applying: true, fixMsg: "applying re-types & new accounts…" });
    const summary: string[] = [];
    try {
      if (retype.length || create.length || reparent.length) {
        const res = await fetch("/api/admin/coa-audit/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_link_id: id, retype_account_ids: retype, create_account_names: create, reparent_account_ids: reparent }),
        });
        const data = await res.json();
        if (data.reauth) { patch(id, { applying: false, fixMsg: "QBO needs reconnect" }); return "reconnect QBO"; }
        // Batch NEVER overrides the cleanup-complete guard — that's the Clean
        // Cut footgun. Refuse the whole run; the bookkeeper can fix items
        // individually (which offer a per-action override) if truly needed.
        if (res.status === 409 && data.error === "cleanup_complete") {
          patch(id, { applying: false, fixMsg: "⛔ Fix-all refused — file is cleanup-complete; fix items individually" });
          return "refused — cleanup-complete";
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.retyped?.length) summary.push(`${data.retyped.length} re-typed`);
        if (data.created?.length) summary.push(`${data.created.length} created`);
        if (data.renested?.length) summary.push(`${data.renested.length} re-nested`);
        if (data.failed?.length) summary.push(`${data.failed.length} fix-failed`);
      }
      // Re-types rebuild accounts under NEW ids — merge proposals captured
      // before the fix phase can point at retired shells and 400 with
      // "Source account no longer exists" (Co Painting, 2026-07-18). When the
      // fix phase ran, re-scan and rebuild the merge list from the fresh chart.
      let mergeRun = mergeList;
      if (mergeList.length > 0 && (retype.length || create.length || reparent.length)) {
        patch(id, { fixMsg: "re-scanning before merges…" });
        const fresh = await scan(id);
        if (fresh) {
          mergeRun = (fresh.mergeProposals || [])
            .filter((p) => p.action === "merge" && p.targetId)
            .map((p) => ({ p, targetId: p.targetId as string }));
        }
        patch(id, { applying: true });
      }
      let merged = 0, mergeFail = 0, tooLarge = 0;
      for (let i = 0; i < mergeRun.length; i++) {
        const { p, targetId } = mergeRun[i];
        patch(id, { fixMsg: `merging ${i + 1}/${mergeRun.length}: ${p.sourceName}…` });
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await fetch("/api/admin/coa-audit/merge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_link_id: id, source_account_id: p.sourceId, target_account_id: targetId }),
          });
          // eslint-disable-next-line no-await-in-loop
          const data = await res.json();
          if (data.reauth) { mergeFail++; continue; }
          // Batch refuses on a cleanup-complete file (merge-only case).
          if (res.status === 409 && data.error === "cleanup_complete") {
            patch(id, { applying: false, fixMsg: "⛔ Fix-all refused — file is cleanup-complete; merge items individually" });
            return "refused — cleanup-complete";
          }
          if (data.tooLarge) { tooLarge++; continue; }
          if (data.ok === false) { mergeFail++; continue; }
          if (!res.ok) { mergeFail++; continue; }
          if (data.failures?.length && !data.inactivated) mergeFail++;
          else merged++;
        } catch { mergeFail++; }
      }
      if (merged) summary.push(`${merged} merged`);
      if (tooLarge) summary.push(`${tooLarge} too big — use QBO reclassify`);
      if (mergeFail) summary.push(`${mergeFail} merge-failed`);
      if (skipped) summary.push(`${skipped} left for review`);
    } catch (e: any) {
      patch(id, { applying: false, fixMsg: e.message });
      return e.message;
    }
    // Refresh conformance, then show the aggregate result.
    await scan(id);
    const s = summary.join(" · ") || "no changes";
    patch(id, { applying: false, fixMsg: s });
    return s;
  }

  // One-click per client: approve + apply EVERY fix at once — all re-types,
  // all missing-account creates, and all merges that have a target. Merges
  // with no confident target are left for manual review. One confirm, then it
  // runs the batch fix and each merge sequentially, and re-scans at the end.
  async function applyAll(id: string, clientName: string) {
    const d = rows[id]?.drift;
    if (!d) return;
    const retype = d.wrongType.map((w) => w.id);
    const create = [...d.missingRequired];
    const reparent = (d.wrongParent || []).map((w) => w.id);
    const mergeList = (d.mergeProposals || [])
      .filter((p) => p.action === "merge")
      .map((p) => ({ p, targetId: mergeSel[id]?.[p.sourceId] || p.targetId || "" }))
      .filter((x) => x.targetId);
    const mergesTotal = (d.mergeProposals || []).filter((p) => p.action === "merge").length;
    const skipped = mergesTotal - mergeList.length;
    if (retype.length + create.length + reparent.length + mergeList.length === 0) return;

    const tName = (tid: string, p: MergeProposal) =>
      (d.mergeTargets || []).find((t) => t.id === tid)?.name || p.targetName || "target";
    const mergeLines = mergeList.map(({ p, targetId }) => `   • ${p.sourceName} → ${tName(targetId, p)}`).join("\n");
    const msg =
      `Approve & apply ALL fixes to ${clientName}'s live QuickBooks?\n\n` +
      `• ${retype.length} account re-type(s)\n` +
      `• ${create.length} new account(s)\n` +
      `• ${reparent.length} re-nest(s) under master headings\n` +
      `• ${mergeList.length} merge(s) — each moves ALL year-to-date transactions (including already-closed months) onto the target and deactivates the source:\n${mergeLines || "   (none)"}\n\n` +
      (skipped ? `${skipped} non-master account(s) have no clear target and are left for manual review.\n\n` : "") +
      `This rewrites the books. Continue?`;
    if (!confirm(msg)) return;
    setExpanded(id);
    await runAllFixes(id);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Owner-only: run the full Fix-all pipeline across the ticked clients, a few
  // at a time, after ONE confirmation for the whole batch.
  async function runSelected() {
    if (!isOwner) return;
    const ids = activeClients.map((c) => c.id).filter((id) => selected.has(id) && fixCountOf(id) > 0);
    if (ids.length === 0) return;
    const names = ids.map((id) => clients.find((c) => c.id === id)?.client_name || id);
    const preview = names.slice(0, 15).map((n) => `   • ${n}`).join("\n") + (names.length > 15 ? `\n   … and ${names.length - 15} more` : "");
    const totalFixes = ids.reduce((s, id) => s + fixCountOf(id), 0);
    if (!confirm(
      `Run “Fix all” on ${ids.length} client(s)' LIVE QuickBooks — ${totalFixes} total fixes?\n\n${preview}\n\n` +
      `Each client is re-typed, re-nested, missing accounts created, and duplicate accounts merged (moving YTD transactions + retiring the drained source). This rewrites their books. Continue?`
    )) return;
    setBusy(true);
    const queue = [...ids];
    let done = 0;
    setBatchMsg(`0/${ids.length} clients processed…`);
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        if (!id) break;
        // eslint-disable-next-line no-await-in-loop
        await runAllFixes(id);
        done++;
        setBatchMsg(`${done}/${ids.length} clients processed…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, ids.length) }, worker));
    setBusy(false);
    setBatchMsg(`✓ Fix-all complete on ${ids.length} client(s)`);
    setSelected(new Set());
  }

  function toggle(setter: typeof setRetypeSel, id: string, key: string) {
    setter((prev) => {
      const next = new Set(prev[id] || []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [id]: next };
    });
  }

  // Partition the visible fleet: "needs attention" (top, worst-first) vs.
  // "completed" (< DONE_THRESHOLD issues after a scan — dropped to the bottom).
  const activeClients = visibleClients
    .filter((c) => !isDone(rows[c.id]))
    .sort((a, b) => {
      const rank = (r: RowState) =>
        r.status === "done" && r.drift ? -issueCountOf(r.drift)     // most issues first
        : r.status === "reauth" || r.status === "error" ? 1000       // problems near the bottom
        : 500;                                                       // never-scanned in between
      return rank(rows[a.id]) - rank(rows[b.id]);
    });
  const completedClients = visibleClients.filter((c) => isDone(rows[c.id]));

  const scannedRows = visibleClients.map((c) => rows[c.id]).filter((r) => r?.status === "done" && r.drift);
  const scored = scannedRows.length;
  const avg = scored ? Math.round(scannedRows.reduce((s, r) => s + r.drift!.conformancePct, 0) / scored) : 0;
  const unscanned = visibleClients.filter((c) => rows[c.id]?.status === "idle").length;
  const staleCount = visibleClients.filter((c) => { const r = rows[c.id]; return r?.status === "done" && isStale(r.scannedAt); }).length;
  const strandedTotal = scannedRows.reduce((s, r) =>
    s + (r.drift!.mergeProposals || []).filter((p) => p.deleted).reduce((a, p) => a + Math.abs(p.amount || 0), 0), 0);

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900">
        <strong>Audit + fix.</strong> Measures each client&apos;s live QuickBooks chart against the
        master COA (conformance %, wrong types, non-master sprawl, missing accounts). From the
        detail you can apply the <strong>safe, deterministic fixes</strong> — re-type accounts into
        the right section and create missing required accounts — after reviewing each. Merges and
        renames of non-master accounts (which move transactions) stay in the reviewed per-client
        cleanup. Scans are <strong>saved</strong> — the fleet loads from the last scan, so you only
        re-scan what&apos;s new or stale (&gt;{STALE_DAYS}d). A client with fewer than {DONE_THRESHOLD} issues
        drops to <strong>Completed</strong> at the bottom.
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={scanStale}
          disabled={busy}
          title={`Scan only clients never scanned or last scanned over ${STALE_DAYS} days ago — skips everything already fresh`}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />}
          Scan new &amp; stale{unscanned + staleCount > 0 ? ` (${unscanned + staleCount})` : ""}
        </button>
        <button
          onClick={scanAll}
          disabled={busy}
          title="Re-scan every visible client from scratch (hits QuickBooks for all)"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-ink-slate text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
        >
          <Search size={14} />
          Re-scan all
        </button>
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs font-semibold">
          {(["all", "CA", "US"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRegion(r)}
              disabled={busy}
              className={`px-3 py-1.5 disabled:opacity-50 ${r !== "all" ? "border-l border-gray-200" : ""} ${region === r ? "bg-teal text-white" : "bg-white text-ink-slate hover:bg-gray-50"}`}
            >
              {r === "all" ? `All (${clients.length})` : r === "CA" ? `🇨🇦 Canada (${caCount})` : `🇺🇸 USA (${usCount})`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-ink-slate">
        <span><span className="font-bold text-emerald-700">{completedClients.length}</span> completed</span>
        <span><span className="font-bold text-red-600">{activeClients.filter((c) => rows[c.id].status === "done").length}</span> need attention</span>
        {unscanned > 0 && <span><span className="font-bold text-ink-slate">{unscanned}</span> never scanned</span>}
        {staleCount > 0 && <span><span className="font-bold text-amber-600">{staleCount}</span> stale</span>}
        {scored > 0 && <span>avg conformance <span className={`font-bold ${scoreColor(avg)}`}>{avg}%</span></span>}
        {strandedTotal > 0.5 && <span className="text-red-600 font-semibold">${Math.round(strandedTotal).toLocaleString()} stranded on deleted accounts (fleet)</span>}
      </div>

      {isOwner && (
        <div className="flex items-center gap-3 flex-wrap p-3 bg-amber-50 border border-amber-200 rounded-xl">
          <span className="text-[10px] font-bold text-amber-800 uppercase tracking-wide bg-amber-100 px-2 py-1 rounded">Owner batch</span>
          <button
            onClick={runSelected}
            disabled={busy || selected.size === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
          >
            {busy && batchMsg ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
            Run Fix all on {selected.size} selected
          </button>
          {selected.size > 0 && !busy && (
            <button onClick={() => setSelected(new Set())} className="text-xs font-semibold text-ink-slate hover:text-navy underline">clear</button>
          )}
          {batchMsg && <span className="text-xs text-amber-900 font-medium">{batchMsg}</span>}
          <span className="text-xs text-ink-light">Tick clients below, then run Fix-all across all of them ({BATCH_CONCURRENCY} at a time). Visible to you only.</span>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {isOwner && (
                <th className="px-3 py-2.5 w-8">
                  {(() => {
                    const elig = activeClients.filter((c) => fixCountOf(c.id) > 0).map((c) => c.id);
                    const allOn = elig.length > 0 && elig.every((id) => selected.has(id));
                    return (
                      <input
                        type="checkbox"
                        checked={allOn}
                        disabled={busy || elig.length === 0}
                        onChange={(e) => setSelected(e.target.checked ? new Set(elig) : new Set())}
                        className="accent-amber-600"
                        title="Select all eligible"
                      />
                    );
                  })()}
                </th>
              )}
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Client</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Stage</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Conformance</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Issues</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Matched</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Wrong type</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Non-master</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate">Missing req.</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate" title="$ stranded on retired accounts still carrying a balance (count of such accounts)">Stranded</th>
              <th className="text-left px-4 py-2.5 font-semibold text-ink-slate">Last scan</th>
              <th className="text-right px-4 py-2.5 font-semibold text-ink-slate"></th>
            </tr>
          </thead>
          <tbody>
            {activeClients.length === 0 && (
              <tr><td colSpan={isOwner ? 12 : 11} className="px-4 py-6 text-center text-ink-light text-sm">
                {scored === 0 ? "No scans yet — hit “Scan new & stale” to audit the fleet." : "🎉 Every visible client is under the issue threshold — see Completed below."}
              </td></tr>
            )}
            {activeClients.map((c) => {
              const r = rows[c.id];
              const d = r.drift;
              const fixable = d ? d.wrongType.length + d.missingRequired.length + (d.wrongParent?.length || 0) : 0;
              const mergeable = d ? (d.mergeProposals || []).filter((p) => p.action === "merge" && (mergeSel[c.id]?.[p.sourceId] || p.targetId)).length : 0;
              return (
                <>
                  <tr key={c.id} className={`border-b border-gray-100 hover:bg-gray-50 ${isOwner && selected.has(c.id) ? "bg-amber-50/60" : ""}`}>
                    {isOwner && (
                      <td className="px-3 py-2.5">
                        {fixCountOf(c.id) > 0 && (
                          <input
                            type="checkbox"
                            checked={selected.has(c.id)}
                            disabled={busy || r.applying}
                            onChange={() => toggleSelect(c.id)}
                            className="accent-amber-600"
                          />
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2.5 font-medium text-navy">{c.client_name}</td>
                    <td className="px-4 py-2.5">
                      {initialStages[c.id] ? (
                        <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded ${LIFECYCLE_META[initialStages[c.id]].tone}`}>
                          {LIFECYCLE_META[initialStages[c.id]].label}
                        </span>
                      ) : <span className="text-ink-light">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {r.status === "done" && d ? (
                        <span className={`font-bold ${scoreColor(d.conformancePct)}`}>{d.conformancePct}%</span>
                      ) : r.status === "scanning" ? (
                        <Loader2 size={13} className="animate-spin inline text-teal" />
                      ) : r.status === "reauth" ? (
                        <span className="text-amber-600 text-xs">QBO reconnect</span>
                      ) : r.status === "error" ? (
                        <span className="text-red-600 text-xs" title={r.message}>error</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {d ? <span className={`font-bold ${issueCountOf(d) < DONE_THRESHOLD ? "text-emerald-700" : "text-red-600"}`}>{issueCountOf(d)}</span> : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-emerald-700">{d ? d.matched : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-amber-700">{d ? d.wrongType.length : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-orange-600">{d ? d.nonMaster.length : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-red-600">{d ? d.missingRequired.length : "—"}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {d && strandedOf(d) > 0.5 ? (
                        <span className="text-red-600 font-semibold" title={`${deletedCountOf(d)} retired account(s) still carry a balance`}>
                          ${Math.round(strandedOf(d)).toLocaleString()}
                          <span className="text-[10px] font-normal text-ink-light"> · {deletedCountOf(d)}</span>
                        </span>
                      ) : d ? <span className="text-emerald-700">—</span> : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-left text-xs text-ink-light whitespace-nowrap">
                      {r.scannedAt ? (
                        <span title={`${new Date(r.scannedAt).toLocaleString()}${r.scannedBy ? ` · ${r.scannedBy}` : ""}`}>
                          <span className={isStale(r.scannedAt) ? "text-amber-600 font-semibold" : ""}>{fmtWhen(r.scannedAt)}</span>
                          {r.scannedBy && <span className="block text-[10px] opacity-70">{r.scannedBy}</span>}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {d && canFix && (fixable + mergeable > 0) && (
                        <button
                          onClick={() => applyAll(c.id, c.client_name)}
                          disabled={r.applying}
                          title="Approve & apply every re-type, new account, and merge for this client in one click — works even while the fleet is still scanning"
                          className="inline-flex items-center gap-1 text-xs font-bold text-white bg-teal hover:bg-teal-dark px-2.5 py-1 rounded-lg mr-3 disabled:opacity-50"
                        >
                          {r.applying ? <Loader2 size={11} className="animate-spin" /> : <Wrench size={11} />}
                          Fix all ({fixable + mergeable})
                        </button>
                      )}
                      {d && (fixable + d.nonMaster.length > 0) && (
                        <button
                          className="text-xs font-semibold text-ink-slate hover:text-navy mr-3 underline decoration-dotted"
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                        >
                          {expanded === c.id ? "hide" : "review & fix"}
                        </button>
                      )}
                      <button onClick={() => scan(c.id)} disabled={busy || r.applying} className="text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-50">
                        {r.status === "done" ? "re-scan" : "scan"}
                      </button>
                    </td>
                  </tr>
                  {expanded === c.id && d && (
                    <tr key={`${c.id}-d`} className="border-b border-gray-100 bg-gray-50/60">
                      <td colSpan={isOwner ? 12 : 11} className="px-6 py-3 text-xs text-ink-slate space-y-3">
                        {d.wrongType.length > 0 && (
                          <div>
                            <div className="font-semibold text-amber-700 inline-flex items-center gap-1 mb-1"><AlertTriangle size={11} /> Wrong type — re-type into the right section ({d.wrongType.length})</div>
                            <div className="space-y-0.5">
                              {d.wrongType.map((w) => (
                                <label key={w.id} className="flex items-center gap-2 cursor-pointer hover:text-navy">
                                  <input type="checkbox" checked={retypeSel[c.id]?.has(w.id) ?? false} onChange={() => toggle(setRetypeSel, c.id, w.id)} className="accent-teal" />
                                  <span className="font-medium text-navy">{w.name}</span>
                                  <span className="text-ink-light">{w.currentType} → {w.masterType}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {d.missingRequired.length > 0 && (
                          <div>
                            <div className="font-semibold text-red-600 mb-1">Missing required — create ({d.missingRequired.length})</div>
                            <div className="space-y-0.5">
                              {d.missingRequired.map((name) => (
                                <label key={name} className="flex items-center gap-2 cursor-pointer hover:text-navy">
                                  <input type="checkbox" checked={createSel[c.id]?.has(name) ?? false} onChange={() => toggle(setCreateSel, c.id, name)} className="accent-teal" />
                                  <span className="text-navy">{name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {(d.wrongParent?.length || 0) > 0 && (
                          <div>
                            <div className="font-semibold text-teal-dark mb-1">
                              Wrong nesting — move under the master heading ({d.wrongParent!.length})
                            </div>
                            <div className="text-ink-light mb-1">
                              Right account, wrong spot — sitting under a legacy parent instead of the standard heading. Missing headings get created automatically.
                            </div>
                            <div className="space-y-0.5">
                              {d.wrongParent!.map((w) => (
                                <label key={w.id} className="flex items-center gap-2 cursor-pointer hover:text-navy">
                                  <input type="checkbox" checked={reparentSel[c.id]?.has(w.id) ?? false} onChange={() => toggle(setReparentSel, c.id, w.id)} className="accent-teal" />
                                  <span className="font-medium text-navy">{w.name}</span>
                                  <span className="text-ink-light">{w.currentParent || "top level"} → {w.masterParent || "top level"}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {(() => {
                          const proposals = d.mergeProposals || [];
                          const merges = proposals.filter((p) => p.action === "merge");
                          const left = proposals.filter((p) => p.action !== "merge");
                          if (proposals.length === 0) return null;
                          return (
                            <div>
                              <div className="font-semibold text-orange-600 mb-1 flex items-center gap-2">
                                Merge duplicates into the master account ({merges.length})
                                {d.aiSuggestions && <span className="text-[10px] font-bold text-teal-dark bg-teal-light px-1.5 py-0.5 rounded">AI-suggested</span>}
                              </div>
                              {merges.length > 0 ? (
                                <>
                                  <div className="text-ink-light mb-1.5">Approve one at a time — each moves all YTD transactions onto the target and deactivates the source.</div>
                                  <div className="space-y-1.5">
                                    {merges.map((p) => {
                                      const targets = d.mergeTargets || [];
                                      const sel = mergeSel[c.id]?.[p.sourceId] ?? "";
                                      return (
                                        <div key={p.sourceId} className="bg-white border border-orange-100 rounded-lg px-2.5 py-1.5">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium text-navy">{p.sourceName}</span>
                                            <span className="text-[10px] text-ink-light">[{p.sourceType}]</span>
                                            {p.deleted && (
                                              <span className="text-[10px] font-bold text-red-700 bg-red-50 px-1.5 py-0.5 rounded" title="Inactive account still carrying a balance — merging reactivates, drains, and re-retires it">
                                                deleted · ${Math.round(Math.abs(p.amount || 0)).toLocaleString()} stranded
                                              </span>
                                            )}
                                            <span className="text-ink-light">→</span>
                                            <select
                                              value={sel}
                                              onChange={(e) => setMergeSel((prev) => ({ ...prev, [c.id]: { ...(prev[c.id] || {}), [p.sourceId]: e.target.value } }))}
                                              className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white text-navy max-w-[220px]"
                                            >
                                              <option value="">Pick target…</option>
                                              {targets.map((t) => (
                                                <option key={t.id} value={t.id}>{t.name}</option>
                                              ))}
                                            </select>
                                            {p.confident && sel === p.targetId && (
                                              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">suggested</span>
                                            )}
                                            {canFix && (
                                              <button
                                                onClick={() => applyMerge(c.id, c.client_name, p, targets)}
                                                disabled={!sel || mergeBusy === p.sourceId || !!mergeBusy || r.applying}
                                                className="text-[11px] font-bold text-white bg-orange-600 hover:bg-orange-700 px-2.5 py-1 rounded disabled:opacity-50 inline-flex items-center gap-1"
                                              >
                                                {mergeBusy === p.sourceId ? <Loader2 size={11} className="animate-spin" /> : null}
                                                Approve merge
                                              </button>
                                            )}
                                            {mergeMsg[p.sourceId] && (
                                              <span className="text-[11px] text-navy">{mergeMsg[p.sourceId]}</span>
                                            )}
                                          </div>
                                          {p.reason && <div className="text-[11px] text-ink-light mt-0.5 italic">{p.reason}</div>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              ) : (
                                <div className="text-ink-light">No obvious merges — every off-standard account is a real bank / asset / loan / income account or has no clear home.</div>
                              )}
                              {left.length > 0 && (
                                <details className="mt-1.5">
                                  <summary className="text-ink-light cursor-pointer">{left.length} account(s) left as-is (not merge candidates)</summary>
                                  <div className="text-[11px] text-ink-light mt-1 space-y-0.5 pl-2">
                                    {left.map((p) => (
                                      <div key={p.sourceId}><span className="font-medium text-navy">{p.sourceName}</span> <span className="opacity-70">[{p.sourceType}]</span>{p.reason ? ` — ${p.reason}` : ""}</div>
                                    ))}
                                  </div>
                                </details>
                              )}
                              <div className="text-ink-light mt-1 italic">Renames/deletes and anything without an obvious target still go through the full per-client COA cleanup.</div>
                            </div>
                          );
                        })()}
                        <div className="flex items-center gap-3 pt-1">
                          {canFix && (
                          <button
                            onClick={() => applyFix(c.id, c.client_name)}
                            disabled={r.applying || ((retypeSel[c.id]?.size ?? 0) + (createSel[c.id]?.size ?? 0) + (reparentSel[c.id]?.size ?? 0) === 0)}
                            className="inline-flex items-center gap-1.5 bg-teal text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-teal-dark disabled:opacity-50"
                          >
                            {r.applying ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                            Apply selected fixes ({(retypeSel[c.id]?.size ?? 0) + (createSel[c.id]?.size ?? 0) + (reparentSel[c.id]?.size ?? 0)})
                          </button>
                          )}
                          {r.fixMsg && (
                            <span className="text-[11px] inline-flex items-center gap-1 text-navy">
                              <CheckCircle2 size={11} className="text-emerald-600" /> {r.fixMsg}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {completedClients.length > 0 && (
        <details className="bg-white rounded-2xl border border-gray-100 overflow-hidden group" open>
          <summary className="px-4 py-3 cursor-pointer font-semibold text-emerald-700 flex items-center gap-2 select-none hover:bg-gray-50">
            <CheckCircle2 size={15} />
            Completed ({completedClients.length})
            <span className="font-normal text-ink-light text-xs">— under {DONE_THRESHOLD} issues, verified by last scan</span>
          </summary>
          <table className="w-full text-sm border-t border-gray-100">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2 font-semibold text-ink-slate">Client</th>
                <th className="text-right px-4 py-2 font-semibold text-ink-slate">Conformance</th>
                <th className="text-right px-4 py-2 font-semibold text-ink-slate">Issues</th>
                <th className="text-left px-4 py-2 font-semibold text-ink-slate">Completed</th>
                <th className="text-left px-4 py-2 font-semibold text-ink-slate">By</th>
                <th className="text-right px-4 py-2 font-semibold text-ink-slate"></th>
              </tr>
            </thead>
            <tbody>
              {completedClients.map((c) => {
                const r = rows[c.id];
                const d = r.drift!;
                return (
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-navy">{c.client_name}</td>
                    <td className="px-4 py-2 text-right"><span className={`font-bold ${scoreColor(d.conformancePct)}`}>{d.conformancePct}%</span></td>
                    <td className="px-4 py-2 text-right"><span className="font-bold text-emerald-700">{issueCountOf(d)}</span></td>
                    <td className="px-4 py-2 text-left text-xs text-ink-light whitespace-nowrap" title={r.scannedAt ? new Date(r.scannedAt).toLocaleString() : ""}>
                      <span className={isStale(r.scannedAt) ? "text-amber-600 font-semibold" : ""}>{fmtWhen(r.scannedAt) || "—"}</span>
                      {isStale(r.scannedAt) && <span className="ml-1 text-[10px] text-amber-600">stale</span>}
                    </td>
                    <td className="px-4 py-2 text-left text-xs text-ink-light">{r.scannedBy || "—"}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button onClick={() => scan(c.id)} disabled={busy || r.applying} className="text-xs font-semibold text-teal hover:text-teal-dark disabled:opacity-50">
                        {r.status === "scanning" ? <Loader2 size={12} className="animate-spin inline" /> : "re-scan"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
