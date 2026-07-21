"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight, CheckCircle2, Circle, ClipboardList,
  Loader2, MinusCircle, PlayCircle, Plus, Sparkles, X, XCircle,
} from "lucide-react";
import { ClientRecCard, type ProdClient } from "../production/rec-card";
import { ClientBadges } from "@/components/ClientBadges";
import { EscalateMenu, EscalationStrip } from "@/components/escalations-ui";
import { type AttentionState } from "@/lib/client-attention-state";

/**
 * Three-column cleanup board. Data comes straight from the existing
 * kanban onboarding API (compute-on-read from live job state) — its six
 * stages collapse to three columns here, and every card shows the full
 * step checklist so a bookkeeper always knows what's next.
 *
 * Columns:
 *   needs_cleanup                                  → Needs Cleanup
 *   coa/reclass in progress, awaiting stripe, bs   → In Progress
 *   review (statement sign-off submitted)          → Awaiting Mgr Review
 */

interface KanbanCard {
  id: string;
  client_name: string;
  urgent?: boolean;
  urgent_note?: string | null;
  stripe_connected: boolean;
  stripe_pending: boolean;
  stripe_request_sent_at: string | null;
  stripe_not_required: boolean;
  bs_recon_started: boolean;
  bs_recon_in_progress: boolean;
  cleanup_pdf_href: string | null;
  due_date: string | null;
  bookkeeper: { id: string; full_name: string; avatar_url: string | null } | null;
  latest_coa_job: { id: string; status: string } | null;
  latest_reclass_job: { id: string; status: string } | null;
  bank_rule_count: number;
  has_complete_reclass: boolean;
}

/* ── Next-step chips ──────────────────────────────────────────────────
   One derived label per card answering "what's the next action?" —
   mirrors the funnel audit so the board reads as waves instead of one
   giant In Progress pile. Lower rank = further along (sorted first). */

type ChipKey =
  | "signoff_submitted"
  | "signoff_only"
  | "needs_rules"
  | "reclass_review"
  | "needs_reclass"
  | "coa_review"
  | "failed"
  | "not_started";

const CHIP_META: Record<ChipKey, { label: string; cls: string; rank: number }> = {
  signoff_submitted: { label: "Awaiting mgr review", cls: "bg-teal-light text-teal-dark", rank: 0 },
  signoff_only: { label: "Sign-off only", cls: "bg-emerald-100 text-emerald-700", rank: 1 },
  needs_rules: { label: "Needs bank rules", cls: "bg-teal/15 text-teal-dark", rank: 2 },
  reclass_review: { label: "Reclass in review", cls: "bg-blue-100 text-blue-700", rank: 3 },
  needs_reclass: { label: "Needs reclass", cls: "bg-amber-100 text-amber-700", rank: 4 },
  coa_review: { label: "COA in review", cls: "bg-blue-100 text-blue-700", rank: 5 },
  failed: { label: "Job failed — fix", cls: "bg-red-100 text-red-700", rank: 6 },
  not_started: { label: "Not started", cls: "bg-gray-100 text-ink-slate", rank: 7 },
};

function classifyCard(card: KanbanCard, inReview: boolean): ChipKey {
  if (inReview) return "signoff_submitted";
  const coa = card.latest_coa_job;
  const reclass = card.latest_reclass_job;
  const reclassDone = card.has_complete_reclass || reclass?.status === "complete";
  if (coa?.status === "failed" || (reclass?.status === "failed" && !reclassDone)) return "failed";
  if (reclassDone && card.bank_rule_count > 0) return "signoff_only";
  if (reclassDone) return "needs_rules";
  if (reclass && ACTIVE.has(reclass.status)) return "reclass_review";
  if (coa?.status === "complete") return "needs_reclass";
  if (coa && ACTIVE.has(coa.status)) return "coa_review";
  return "not_started";
}

type StepState = "todo" | "active" | "done" | "failed" | "skipped";

interface Step {
  label: string;
  state: StepState;
  href: string | null;
}

const ACTIVE = new Set(["pending", "executing", "in_review"]);

function buildSteps(card: KanbanCard, inReview: boolean): Step[] {
  const coa = card.latest_coa_job;
  const reclass = card.latest_reclass_job;

  const coaState: StepState = !coa
    ? "todo"
    : coa.status === "complete"
    ? "done"
    : coa.status === "failed"
    ? "failed"
    : "active";

  const reclassState: StepState = !reclass
    ? "todo"
    : reclass.status === "complete"
    ? "done"
    : reclass.status === "failed"
    ? "failed"
    : "active";

  const stripeState: StepState = card.stripe_not_required
    ? "skipped"
    : card.stripe_connected
    ? "done"
    : card.stripe_pending || card.stripe_request_sent_at
    ? "active"
    : "todo";

  const bsState: StepState = inReview
    ? "done"
    : card.bs_recon_in_progress
    ? "active"
    : card.bs_recon_started
    ? "done"
    : "todo";

  const signoffState: StepState = inReview ? "active" : "todo";

  return [
    {
      label: "1 · COA Cleanup",
      state: coaState,
      href: coa ? `/jobs/${coa.id}/review` : "/jobs/new",
    },
    {
      label: "2 · Reclass",
      state: reclassState,
      href: reclass ? `/reclass/${reclass.id}/review` : "/reclass/new",
    },
    {
      label: "3 · Bank Rules",
      state: card.bank_rule_count > 0 ? "done" : "todo",
      href: reclass ? `/reclass/${reclass.id}/bank-rules` : "/rules/new",
    },
    { label: "4 · Stripe", state: stripeState, href: null },
    {
      label: "5 · BS Cleanup",
      state: bsState,
      href: `/balance-sheet/${card.id}/cleanup`,
    },
    {
      label: "6 · Statements sign-off",
      state: signoffState,
      href: null,
    },
  ];
}

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <CheckCircle2 size={12} className="text-emerald-600" />;
    case "active":
      return <PlayCircle size={12} className="text-teal" />;
    case "failed":
      return <XCircle size={12} className="text-red-600" />;
    case "skipped":
      return <MinusCircle size={12} className="text-ink-light" />;
    default:
      return <Circle size={12} className="text-gray-300" />;
  }
}

export function CleanupBoard() {
  const [columns, setColumns] = useState<Record<string, { cards: KanbanCard[]; total: number }> | null>(null);
  const [bookkeepers, setBookkeepers] = useState<{ id: string; full_name: string }[]>([]);
  const [signoffs, setSignoffs] = useState<ProdClient[]>([]);
  const [isSenior, setIsSenior] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedSignoff, setSelectedSignoff] = useState<string | null>(null);

  // Attention states (escalated / BS owed / disconnected / stuck) — one feed
  // for every badge on this board.
  const [attention, setAttention] = useState<Record<string, AttentionState>>({});

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [kanbanRes, recRes, attRes] = await Promise.all([
        fetch("/api/kanban/onboarding"),
        fetch("/api/monthly-rec?scope=signoffs"),
        fetch("/api/attention"),
      ]);
      const kanban = await kanbanRes.json();
      if (!kanbanRes.ok) throw new Error(kanban.error || `HTTP ${kanbanRes.status}`);
      setColumns(kanban.columns || null);
      setBookkeepers(kanban.bookkeepers || []);
      if (recRes.ok) {
        const rec = await recRes.json();
        setSignoffs(rec.cleanup_signoffs || []);
        setIsSenior(!!rec.is_senior);
      }
      if (attRes.ok) {
        const att = await attRes.json();
        setAttention(att.clients || {});
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Deep-link focus: /cleanup?focus={clientId} (client profile "Continue"
  // button) scrolls to that client's card and pulses it once loaded.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusConsumed = useRef(false);
  useEffect(() => {
    if (focusConsumed.current || loading || !columns) return;
    focusConsumed.current = true;
    const f = new URLSearchParams(window.location.search).get("focus");
    if (!f) return;
    setFocusId(f);
    setTimeout(() => {
      document.getElementById(`cleanup-card-${f}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    setTimeout(() => setFocusId(null), 3000);
  }, [loading, columns]);

  const [chipFilter, setChipFilter] = useState<ChipKey | null>(null);

  const collapsed = useMemo(() => {
    const get = (k: string) => columns?.[k]?.cards || [];
    // In Progress sorts furthest-along first (chip rank asc) so the
    // sign-off-only cards stack at the top and the column reads as a funnel.
    const inProgress = [
      ...get("coa_in_progress"),
      ...get("reclass_in_progress"),
      ...get("awaiting_stripe"),
      ...get("bs_cleanup"),
    ].sort(
      (a, b) =>
        CHIP_META[classifyCard(a, false)].rank - CHIP_META[classifyCard(b, false)].rank
    );
    return {
      needs_cleanup: get("needs_cleanup"),
      in_progress: inProgress,
      review: get("review"),
    };
  }, [columns]);

  // Funnel counts across the whole board, for the summary strip.
  const funnel = useMemo(() => {
    const counts = new Map<ChipKey, number>();
    const add = (cards: KanbanCard[], inReview: boolean) => {
      for (const c of cards) {
        const k = classifyCard(c, inReview);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    };
    add(collapsed.needs_cleanup, false);
    add(collapsed.in_progress, false);
    add(collapsed.review, true);
    return counts;
  }, [collapsed]);

  // "Flagged only" — show just the cards with a VISIBLE badge at this stage
  // (escalated, BS owed, disconnected, reclass paused). Billing is excluded
  // to match the badges: cleanup-stage cards don't render billing chips, and
  // a filter that keeps badge-less cards reads as broken.
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  // Per-assignee filter — "see only my/this bookkeeper's accounts".
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");

  const urgentFirst = (cards: KanbanCard[]) =>
    [...cards].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent));
  const visible = (cards: KanbanCard[], inReview: boolean) => {
    let out = urgentFirst(chipFilter ? cards.filter((c) => classifyCard(c, inReview) === chipFilter) : cards);
    if (flaggedOnly)
      out = out.filter((c) => {
        const a = attention[c.id];
        return a && (a.escalations.length > 0 || a.bs_owed || a.disconnected || a.stuck_job);
      });
    if (assigneeFilter !== "all")
      out = out.filter((c) =>
        assigneeFilter === "unassigned" ? !c.bookkeeper : c.bookkeeper?.id === assigneeFilter
      );
    return out;
  };

  const boardClientIds = useMemo(
    () => [...collapsed.needs_cleanup, ...collapsed.in_progress, ...collapsed.review].map((c) => c.id),
    [collapsed]
  );

  const signoffByClient = useMemo(
    () => new Map(signoffs.map((s) => [s.id, s])),
    [signoffs]
  );

  const selectedRun = selectedSignoff ? signoffByClient.get(selectedSignoff) : null;

  const COLS: { id: keyof typeof collapsed; title: string; tone: string; hint: string }[] = [
    { id: "needs_cleanup", title: "Needs Cleanup", tone: "border-gray-200", hint: "New — start with COA cleanup" },
    { id: "in_progress", title: "In Progress", tone: "border-teal/40", hint: "Working the checklist" },
    { id: "review", title: "Awaiting Mgr Review", tone: "border-teal-border", hint: "Statements submitted — manager approves & sends" },
  ];

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-ink-slate">
          Clients progress through cleanup steps. When the manager approves the sign-off,
          statements are sent to the client and the account moves to{" "}
          <strong>Production</strong> (ongoing management).
        </p>
      </div>

      {/* Escalations — triage happens ON the board, not in another tool. */}
      {!loading && <EscalationStrip clientIds={boardClientIds} onChanged={load} />}

      {/* Funnel strip — clickable counts that filter the board */}
      {!loading && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Assignee filter — "show only this bookkeeper's accounts". */}
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            className="text-xs font-semibold px-2.5 py-1 rounded-full border border-gray-200 bg-white text-navy outline-none hover:border-teal cursor-pointer"
            title="Filter the board to one bookkeeper's accounts"
          >
            <option value="all">All assignees</option>
            <option value="unassigned">Unassigned</option>
            {bookkeepers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.full_name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setFlaggedOnly((f) => !f)}
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-all ${
              flaggedOnly
                ? "bg-red-100 text-red-800 border-red-300 ring-2 ring-navy/40"
                : "bg-white text-ink-slate border-gray-200 hover:border-red-200"
            }`}
            title="Show only clients with an attention flag (escalated, BS owed, disconnected, stuck)"
          >
            ⚠ Flagged only
          </button>
          {(Object.keys(CHIP_META) as ChipKey[])
            .sort((a, b) => CHIP_META[a].rank - CHIP_META[b].rank)
            .filter((k) => (funnel.get(k) || 0) > 0)
            .map((k) => (
              <button
                key={k}
                onClick={() => setChipFilter(chipFilter === k ? null : k)}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full transition-all ${CHIP_META[k].cls} ${
                  chipFilter === k
                    ? "ring-2 ring-navy/60"
                    : chipFilter
                    ? "opacity-40"
                    : ""
                }`}
              >
                {funnel.get(k)} {CHIP_META[k].label}
              </button>
            ))}
          {chipFilter && (
            <button
              onClick={() => setChipFilter(null)}
              className="text-xs text-ink-slate underline hover:text-navy ml-1"
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
          <Loader2 className="animate-spin text-teal mx-auto" size={28} />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {COLS.map((col) => {
            const cards = visible(collapsed[col.id], col.id === "review");
            // no overflow-hidden on the column shell — it clips the Escalate popover
            return (
              <div key={col.id} className={`bg-white rounded-2xl border-2 ${col.tone}`}>
                <div className="px-3 py-2.5 border-b border-gray-100">
                  <div className="flex items-center gap-2">
                    <ClipboardList size={14} className="text-ink-slate" />
                    <span className="text-sm font-bold text-navy">{col.title}</span>
                    <span className="text-xs text-ink-light ml-auto">{cards.length}</span>
                  </div>
                  <div className="text-[10px] text-ink-light mt-0.5">{col.hint}</div>
                </div>
                <div className="p-2 space-y-2 min-h-[100px]">
                  {cards.length === 0 && (
                    <div className="text-center text-[11px] text-ink-light py-5">
                      {col.id === "needs_cleanup" ? (
                        <span className="inline-flex items-center gap-1">
                          <Sparkles size={11} /> Nothing waiting
                        </span>
                      ) : (
                        "—"
                      )}
                    </div>
                  )}
                  {cards.map((card) => (
                    <div
                      key={card.id}
                      id={`cleanup-card-${card.id}`}
                      className={`rounded-2xl transition-shadow duration-700 ${
                        focusId === card.id ? "ring-4 ring-teal/50 shadow-lg" : ""
                      }`}
                    >
                      <CleanupCard
                        card={card}
                        inReview={col.id === "review"}
                        hasSignoff={signoffByClient.has(card.id)}
                        isSenior={isSenior}
                        bookkeepers={bookkeepers}
                        attention={attention[card.id]}
                        onChanged={load}
                        onOpenSignoff={() =>
                          setSelectedSignoff(selectedSignoff === card.id ? null : card.id)
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Statement sign-off flow (the same review the manager sees), as a modal
          overlay so it opens OVER the board — not as a block below the fold. */}
      {selectedRun && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setSelectedSignoff(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h3 className="text-sm font-bold text-navy">
                {selectedRun.client_name} — cleanup statements sign-off
              </h3>
              <button
                onClick={() => setSelectedSignoff(null)}
                className="text-ink-light hover:text-navy"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="overflow-y-auto p-4">
              <ClientRecCard
                client={selectedRun}
                period={selectedRun.run?.period || ""}
                isSenior={isSenior}
                onChanged={load}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CleanupCard({
  card,
  inReview,
  hasSignoff,
  isSenior,
  bookkeepers,
  attention,
  onChanged,
  onOpenSignoff,
}: {
  card: KanbanCard;
  inReview: boolean;
  hasSignoff: boolean;
  isSenior: boolean;
  bookkeepers: { id: string; full_name: string }[];
  attention?: AttentionState;
  onChanged: () => void;
  onOpenSignoff: () => void;
}) {
  const steps = buildSteps(card, inReview);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bkId, setBkId] = useState(card.bookkeeper?.id || "");
  const [due, setDue] = useState(card.due_date ? card.due_date.slice(0, 10) : "");

  const overdue =
    !inReview && card.due_date && new Date(card.due_date) < new Date(new Date().toISOString().slice(0, 10));

  async function saveAssignment() {
    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assigned_bookkeeper_id: bkId || null,
          due_date: due || null,
        }),
      });
      if (res.ok) {
        setEditing(false);
        onChanged();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Link
              href={`/clients/${card.id}`}
              className="text-sm font-semibold text-navy hover:text-teal truncate"
            >
              {card.client_name}
            </Link>
            {card.urgent && (
              <span
                title={card.urgent_note || "Urgent — books ASAP"}
                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 bg-red-600 text-white"
              >
                URGENT
              </span>
            )}
            <span
              className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${CHIP_META[classifyCard(card, inReview)].cls}`}
            >
              {CHIP_META[classifyCard(card, inReview)].label}
            </span>
          </div>
          <ClientBadges attention={attention} stage="cleanup" max={2} />
          <div className="text-[10px] text-ink-light flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => isSenior && setEditing(!editing)}
              className={isSenior ? "hover:text-navy hover:underline" : "cursor-default"}
              title={isSenior ? "Assign bookkeeper / set deadline" : undefined}
            >
              {card.bookkeeper?.full_name || "Unassigned"}
            </button>
            {card.due_date && (
              <span
                className={`font-bold px-1.5 py-0.5 rounded ${
                  overdue ? "bg-red-100 text-red-700" : "bg-gray-100 text-ink-slate"
                }`}
                title={overdue ? "Past deadline" : "Deadline"}
              >
                due {card.due_date.slice(0, 10)}{overdue ? " ⚠" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {card.cleanup_pdf_href && (
            <a
              href={card.cleanup_pdf_href}
              className="text-[10px] font-semibold text-teal hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              PDF
            </a>
          )}
          <EscalateMenu
            clientLinkId={card.id}
            clientName={card.client_name}
            onRaised={onChanged}
            small
          />
        </div>
      </div>

      {editing && (
        <div className="mt-2 p-2 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
          <select
            value={bkId}
            onChange={(e) => setBkId(e.target.value)}
            className="w-full text-[11px] px-2 py-1 rounded border border-slate-200 bg-white"
          >
            <option value="">— unassigned —</option>
            {bookkeepers.map((b) => (
              <option key={b.id} value={b.id}>{b.full_name}</option>
            ))}
          </select>
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="w-full text-[11px] px-2 py-1 rounded border border-slate-200 bg-white"
          />
          <div className="flex gap-1.5">
            <button
              onClick={saveAssignment}
              disabled={saving}
              className="text-[11px] font-bold px-2.5 py-1 rounded bg-navy text-white hover:bg-ink-light disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-[11px] font-semibold px-2 py-1 rounded text-ink-slate hover:text-navy"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step checklist */}
      <ul className="mt-2 space-y-1">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 text-[11px]">
            <StepIcon state={s.state} />
            {s.href ? (
              <Link
                href={s.href}
                className={`hover:underline ${
                  s.state === "active"
                    ? "font-semibold text-navy"
                    : s.state === "failed"
                    ? "font-semibold text-red-700"
                    : "text-ink-slate"
                }`}
              >
                {s.label}
                {s.state === "failed" ? " — failed, retry" : ""}
              </Link>
            ) : (
              <span
                className={
                  s.state === "active" ? "font-semibold text-navy" : "text-ink-slate"
                }
              >
                {s.label}
                {s.state === "skipped" ? " (n/a)" : ""}
              </span>
            )}
            <span className="ml-auto" />
            {s.label.startsWith("6") && hasSignoff && (
              <button
                onClick={onOpenSignoff}
                className="inline-flex items-center gap-0.5 text-[10px] font-bold text-teal-dark hover:underline"
              >
                Review sign-off <ArrowUpRight size={9} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
