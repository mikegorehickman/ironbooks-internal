"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle, CalendarCheck, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed,
  Loader2, MailQuestion, OctagonAlert, PlayCircle, Send, Sparkles, X,
} from "lucide-react";
import {
  ClientRecCard, EligibleRow, periodLabel, shiftPeriod,
  type EligibleClient, type ProdClient, type Bookkeeper,
} from "./rec-card";
import { CoaUpdatesBanner } from "./coa-updates-banner";
import { ClientBadges } from "@/components/ClientBadges";
import { EscalateMenu, EscalationStrip } from "@/components/escalations-ui";
import { type AttentionState } from "@/lib/client-attention-state";

/**
 * /production — the month-by-month board for graduated clients.
 *
 * Five columns: four working columns driven by monthly_rec_runs.board_status
 * for the selected period (Not Started / In Progress / Stuck / Waiting on
 * Client), plus a Completed column for runs with status="complete". A client
 * with no run row for the month is Not Started — which is exactly how a
 * finished month "resets": next month has no row yet.
 *
 * A month reaches Completed ONE way: the rec-card close flow (run checks →
 * review statements → attest → send). Picking "✓ Completed" on a card just
 * opens its rec-card — after the 2026-07-04 incident (the board's own
 * Completed path mis-fired real statement emails), the board no longer has
 * a second close path. Picking another status on a completed card reopens it.
 *
 * "Ready for manager review" is not a stored status — submitting the
 * statement review (the rec-card flow) moves the run to pending_review,
 * shown as a purple chip in Waiting on Client.
 */

const WAITING_REASONS = [
  { id: "waiting_reply", label: "Waiting for reply" },
  { id: "waiting_statements", label: "Waiting for statements" },
  { id: "disconnected_feed", label: "Disconnected feed" },
] as const;

// "not_started" survives as a legacy DB value but has NO column — those runs
// display under In Progress (Mike 2026-07-14: a production client's month is
// always in progress; an empty column earns nothing).
type BoardStatus = "not_started" | "in_progress" | "stuck" | "waiting_client" | "ready_for_review";

const COLUMNS: { id: Exclude<BoardStatus, "not_started">; title: string; icon: any; tone: string }[] = [
  { id: "in_progress", title: "In Progress", icon: PlayCircle, tone: "border-teal/40" },
  // "Blocked (this month)" — month-state, deliberately NOT the client-level
  // STUCK JOB badge. A client can be blocked this month and fine as a client.
  { id: "stuck", title: "Blocked (this month)", icon: OctagonAlert, tone: "border-red-300" },
  { id: "waiting_client", title: "Waiting on Client", icon: MailQuestion, tone: "border-amber-300" },
  { id: "ready_for_review", title: "Ready for Manager Review", icon: CheckCircle2, tone: "border-indigo-300" },
];

export function ProductionBoard() {
  const [period, setPeriod] = useState<string>("");
  const [production, setProduction] = useState<ProdClient[]>([]);
  const [eligible, setEligible] = useState<EligibleClient[]>([]);
  const [bookkeepers, setBookkeepers] = useState<Bookkeeper[]>([]);
  const [isSenior, setIsSenior] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Picking "✓ Completed" opens the close card, which renders BELOW the
  // columns — scroll to it and pulse it, or it reads as "nothing happened".
  const [closePulse, setClosePulse] = useState(false);
  function openCloseCard(id: string) {
    setSelectedId(id);
    setClosePulse(true);
    setTimeout(() => {
      document.getElementById("close-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    setTimeout(() => setClosePulse(false), 2600);
  }
  // Attention states (escalated / billing / BS owed / disconnected / stuck).
  const [attention, setAttention] = useState<Record<string, AttentionState>>({});
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  async function load(p?: string) {
    setLoading(true);
    setError("");
    try {
      const [res, attRes] = await Promise.all([
        fetch(`/api/monthly-rec?scope=production${p ? `&period=${p}` : ""}`),
        fetch("/api/attention"),
      ]);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPeriod(body.period);
      setProduction(body.production || []);
      setEligible(body.eligible || []);
      setBookkeepers(body.bookkeepers || []);
      setIsSenior(!!body.is_senior);
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

  const { byColumn, done } = useMemo(() => {
    const byColumn: Record<Exclude<BoardStatus, "not_started">, ProdClient[]> = {
      in_progress: [],
      stuck: [],
      waiting_client: [],
      ready_for_review: [],
    };
    const done: ProdClient[] = [];
    for (const c of production) {
      if (c.run?.status === "complete") {
        done.push(c);
        continue;
      }
      // Submitted-for-review runs ARE the manager-review queue.
      if (c.run?.status === "pending_review") {
        byColumn.ready_for_review.push(c);
        continue;
      }
      const bs = (c.run?.board_status as BoardStatus) || "in_progress";
      byColumn[bs in byColumn ? (bs as Exclude<BoardStatus, "not_started">) : "in_progress"].push(c);
    }
    return { byColumn, done };
  }, [production]);

  const selected = production.find((c) => c.id === selectedId) || null;

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}

      {/* Period switcher + progress */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-3 flex-wrap">
        <div className="p-2 rounded-lg bg-teal-light">
          <CalendarCheck size={18} className="text-teal" />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setSelectedId(null); load(shiftPeriod(period, -1)); }}
            disabled={!period || loading}
            className="p-1.5 rounded hover:bg-gray-100 text-ink-slate disabled:opacity-40"
            aria-label="Previous month"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="font-bold text-navy min-w-[140px] text-center">
            {period ? periodLabel(period) : "…"}
          </span>
          <button
            onClick={() => { setSelectedId(null); load(shiftPeriod(period, 1)); }}
            disabled={!period || loading}
            className="p-1.5 rounded hover:bg-gray-100 text-ink-slate disabled:opacity-40"
            aria-label="Next month"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setFlaggedOnly((f) => !f)}
          className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-all ${
            flaggedOnly
              ? "bg-red-100 text-red-800 border-red-300 ring-2 ring-navy/40"
              : "bg-white text-ink-slate border-gray-200 hover:border-red-200"
          }`}
          title="Show only clients needing intervention (escalated, billing, disconnected, reclass paused)"
        >
          ⚠ Flagged only
        </button>
        {production.length > 0 && (
          <span className="text-sm text-ink-slate">
            <strong className="text-navy">{done.length}</strong> of{" "}
            <strong className="text-navy">{production.length}</strong> done for{" "}
            {period ? periodLabel(period) : ""}
          </span>
        )}
      </div>

      {/* Escalations — triage on the board. */}
      {!loading && (
        <EscalationStrip clientIds={production.map((c) => c.id)} onChanged={() => load(period)} />
      )}

      {/* BS-owed banner — production clients on P&L-only service still owe
          a finished balance sheet. Don't let "in production" hide that. */}
      {!loading && production.some((c) => c.bs_enabled === false) && (
        <div className="bg-sky-50 border border-sky-200 rounded-2xl p-4">
          <div className="text-sm font-bold text-sky-900 flex items-center gap-2">
            <AlertCircle size={15} />
            {production.filter((c) => c.bs_enabled === false).length} production client
            {production.filter((c) => c.bs_enabled === false).length === 1 ? "" : "s"} still owe a
            balance sheet (P&L-only service)
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {production
              .filter((c) => c.bs_enabled === false)
              .map((c) => (
                <a
                  key={c.id}
                  href={`/balance-sheet/${c.id}/cleanup`}
                  className="text-xs font-semibold bg-white border border-sky-200 text-sky-900 px-2.5 py-1 rounded-full hover:border-sky-400"
                  title="Open BS cleanup — flip BS back on from their card here once it's done"
                >
                  {c.client_name} →
                </a>
              ))}
          </div>
          <p className="text-[11px] text-sky-800/80 mt-2">
            Their portal shows the balance sheet as in-progress. Finish the BS cleanup, then flip
            BS back on from their card to restore full statements.
          </p>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
          <Loader2 className="animate-spin text-teal mx-auto" size={28} />
        </div>
      ) : production.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
          <Sparkles size={28} className="mx-auto text-teal mb-2" />
          <h3 className="font-bold text-navy">No clients in production yet</h3>
          <p className="text-sm text-ink-slate mt-1 max-w-md mx-auto">
            Clients land here automatically when a manager approves their
            cleanup sign-off — or promote one below.
          </p>
        </div>
      ) : (
        <>
          {/* ── 5-COLUMN BOARD ── (4 working columns + Completed) */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
            {[
              ...COLUMNS.map((col) => ({
                ...col,
                cards: [...byColumn[col.id]].sort(
                  (a, b) => Number(!!b.urgent) - Number(!!a.urgent)
                ),
              })),
              {
                id: "completed" as const,
                title: "Completed",
                icon: CheckCircle2,
                tone: "border-emerald-300",
                cards: done,
              },
            ]
              .map((col) => ({
                ...col,
                // Intervention states only — bs_owed is a chronic service
                // mode with its own banner here, not a flag to triage.
                cards: flaggedOnly
                  ? col.cards.filter((c) => {
                      const a = attention[c.id];
                      return a && (a.escalations.length > 0 || !!a.billing || a.disconnected || a.stuck_job);
                    })
                  : col.cards,
              }))
              .map((col) => {
              const Icon = col.icon;
              const isCompletedCol = col.id === "completed";
              // no overflow-hidden on the column shell — it clips the Escalate popover
              return (
                <div key={col.id} className={`bg-white rounded-2xl border-2 ${col.tone}`}>
                  <div className="px-3 py-2.5 border-b border-gray-100 flex items-center gap-2">
                    <Icon size={14} className={isCompletedCol ? "text-emerald-600" : "text-ink-slate"} />
                    <span className="text-sm font-bold text-navy">{col.title}</span>
                    <span className="text-xs text-ink-light ml-auto">{col.cards.length}</span>
                  </div>
                  <div className="p-2 space-y-2 min-h-[80px]">
                    {col.cards.length === 0 && (
                      <div className="text-center text-[11px] text-ink-light py-4">—</div>
                    )}
                    {col.cards.map((c) => (
                      <BoardCard
                        key={c.id}
                        client={c}
                        period={period}
                        isSenior={isSenior}
                        bookkeepers={bookkeepers}
                        attention={attention[c.id]}
                        selected={selectedId === c.id}
                        onSelect={() => setSelectedId(selectedId === c.id ? null : c.id)}
                        onCloseIntent={() => openCloseCard(c.id)}
                        onChanged={() => load(period)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── SELECTED CLIENT: full monthly close flow ── */}
          {selected && (
            <div
              id="close-card"
              className={`space-y-2 scroll-mt-4 rounded-2xl transition-shadow duration-700 ${
                closePulse ? "ring-4 ring-teal/50 shadow-lg" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-navy">
                  {selected.client_name} — {periodLabel(period)}
                </h3>
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-ink-light hover:text-navy"
                  aria-label="Close detail"
                >
                  <X size={15} />
                </button>
              </div>
              <CoaUpdatesBanner clientId={selected.id} clientName={selected.client_name} />
              <ClientRecCard
                client={selected}
                period={period}
                isSenior={isSenior}
                onChanged={() => load(period)}
              />
            </div>
          )}

        </>
      )}

      {/* Ready to promote */}
      {!loading && eligible.length > 0 && (
        <div className="bg-teal-light border border-teal/40 rounded-2xl p-4">
          <h3 className="text-sm font-bold text-navy mb-1">
            Next: promote to monthly production ({eligible.length})
          </h3>
          <p className="text-xs text-ink-slate mb-3">
            These clients finished cleanup and are ready to start the monthly routine. {isSenior
              ? "Promote them and they join the monthly routine."
              : "Ask an admin or lead to promote them."}
          </p>
          <ul className="divide-y divide-teal/20">
            {eligible.map((c) => (
              <EligibleRow key={c.id} client={c} isSenior={isSenior} onPromoted={() => load(period)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── COMPACT BOARD CARD ──────────────────────────────────────────────────

function BoardCard({
  client,
  period,
  isSenior,
  bookkeepers,
  attention,
  selected,
  onSelect,
  onCloseIntent,
  onChanged,
}: {
  client: ProdClient;
  period: string;
  isSenior: boolean;
  bookkeepers: Bookkeeper[];
  attention?: AttentionState;
  selected: boolean;
  onSelect: () => void;
  /** "✓ Completed" picked — open the close card and scroll to it. */
  onCloseIntent: () => void;
  onChanged: () => void;
}) {
  const [togglingBs, setTogglingBs] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const bsOff = client.bs_enabled === false;

  // Reassign the client to a bookkeeper (admin/lead only). Reuses the
  // shared assign endpoint so it's audit-logged like everywhere else.
  async function assignTo(bookkeeperId: string) {
    setAssigning(true);
    try {
      const res = await fetch(`/api/clients/${client.id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookkeeper_id: bookkeeperId || null }),
      });
      if (res.ok) onChanged();
    } finally {
      setAssigning(false);
    }
  }

  async function toggleBs() {
    if (
      !confirm(
        bsOff
          ? `Turn the Balance Sheet back ON for ${client.client_name}? Full monthly service resumes (BS checks + BS/CFS statements).`
          : `Switch ${client.client_name} to P&L-ONLY service? BS checks and the BS/CFS statements are skipped until you turn it back on — use this when the client is in production but their balance sheet cleanup isn't finished.`
      )
    )
      return;
    setTogglingBs(true);
    try {
      const res = await fetch(`/api/clients/${client.id}/production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: bsOff ? "bs_on" : "bs_off" }),
      });
      if (res.ok) onChanged();
    } finally {
      setTogglingBs(false);
    }
  }
  const run = client.run;
  const isPending = run?.status === "pending_review";
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reasons, setReasons] = useState<string[]>(run?.waiting_reasons || []);
  const [note, setNote] = useState(run?.status_note || "");

  useEffect(() => {
    setReasons(run?.waiting_reasons || []);
    setNote(run?.status_note || "");
  }, [run?.waiting_reasons, run?.status_note]);

  async function saveBoard(board_status: string, extra?: { waiting_reasons?: string[]; status_note?: string }) {
    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${client.id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "board",
          period,
          board_status,
          waiting_reasons: extra?.waiting_reasons ?? reasons,
          status_note: extra?.status_note ?? note,
        }),
      });
      if (res.ok) {
        onChanged();
      } else {
        // Never fail silently: a rejected move used to just do nothing, so a
        // card that wouldn't move looked like a mystery (Mike, 2026-07-15 —
        // "Ready for Manager Review" bounced off a stale DB CHECK constraint).
        const body = await res.json().catch(() => ({}));
        alert(body.error || `Couldn't update the board (HTTP ${res.status}).`);
      }
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  // Reopen a completed month back into the active board, optionally landing
  // it in a target column. Reopen clears the close, then sets the column.
  async function reopenTo(target: string) {
    if (
      !confirm(
        `Reopen ${client.client_name}'s ${periodLabel(period)} month-end? It moves back into the active board.`
      )
    )
      return;
    setSaving(true);
    try {
      const r1 = await fetch(`/api/clients/${client.id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen", period }),
      });
      if (!r1.ok) {
        const b = await r1.json().catch(() => ({}));
        alert(b.error || "Couldn't reopen");
        return;
      }
      if (target === "waiting_client") {
        setEditing(true);
        return;
      }
      await fetch(`/api/clients/${client.id}/monthly-rec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "board", period, board_status: target, waiting_reasons: [] }),
      });
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  const checksOverall = run?.checks?.overall;
  const isComplete = run?.status === "complete";
  const closedExternally = (run as any)?.email_delivery?.via === "external";
  const currentStatus = isPending
    ? "waiting_client"
    : isComplete
    ? "completed"
    : (((run?.board_status as string) === "not_started" ? "in_progress" : (run?.board_status as string)) || "in_progress");

  return (
    <div
      className={`rounded-xl border bg-white px-3 py-2.5 ${
        selected ? "border-teal ring-1 ring-teal/30" : "border-gray-150 border-gray-200"
      }`}
    >
      <div className="flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <a
              href={`/clients/${client.id}`}
              className="text-sm font-semibold text-navy hover:text-teal hover:underline"
              title="Open client profile"
            >
              {client.client_name}
            </a>
            {client.paused && (
              <span className="text-[9px] font-bold bg-gray-100 text-ink-slate px-1 py-0.5 rounded">PAUSED</span>
            )}
            <ClientBadges attention={attention} stage="production" max={2} />
          </div>
          {client.contact_name && (
            <button onClick={onSelect} className="text-left w-full">
              <div className="text-[11px] text-gray-400 truncate">{client.contact_name}</div>
            </button>
          )}
        </div>
        <EscalateMenu
          clientLinkId={client.id}
          clientName={client.client_name}
          onRaised={onChanged}
          small
        />
      </div>
      <button onClick={onSelect} className="w-full text-left">
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {isPending ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded">
              <Send size={9} />
              Ready for manager review
            </span>
          ) : isComplete ? (
            <>
              <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                <CheckCircle2 size={9} />
                Completed{run?.completed_at ? ` ${new Date(run.completed_at).toLocaleDateString()}` : ""}
              </span>
              {closedExternally && (
                <span className="text-[10px] font-semibold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                  closed outside SNAP
                </span>
              )}
            </>
          ) : run?.checks_ran_at ? (
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                checksOverall === "pass"
                  ? "bg-emerald-100 text-emerald-700"
                  : checksOverall === "warn"
                  ? "bg-amber-100 text-amber-800"
                  : "bg-red-100 text-red-700"
              }`}
            >
              checks: {checksOverall}
            </span>
          ) : (
            <span className="text-[10px] text-ink-light">no checks yet</span>
          )}
          {(run?.waiting_reasons || []).map((r) => {
            const def = WAITING_REASONS.find((w) => w.id === r);
            return def ? (
              <span key={r} className="text-[10px] font-semibold bg-amber-50 border border-amber-200 text-amber-800 px-1.5 py-0.5 rounded">
                {def.label}
              </span>
            ) : null;
          })}
        </div>
        {run?.status_note && (
          <div className="text-[10px] text-ink-slate mt-1 truncate" title={run.status_note}>
            {run.status_note}
          </div>
        )}
      </button>

      {/* Board controls */}
      <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-1.5">
        <select
          value={currentStatus}
          disabled={saving || isPending}
          title={
            isPending
              ? "Submitted — waiting on the manager"
              : isComplete
              ? "Completed — pick another status to reopen"
              : "Move this client"
          }
          onChange={(e) => {
            const v = e.target.value;
            if (v === currentStatus) return;
            if (v === "completed") {
              // The close lives in the rec-card flow (checks -> review ->
              // attest -> send). Opening the card IS the action here — and
              // it renders below the columns, so scroll the user to it.
              onCloseIntent();
              return;
            } else if (isComplete) {
              // Leaving the Completed column = reopen, then land the column.
              reopenTo(v);
            } else if (v === "waiting_client") {
              setEditing(true);
            } else {
              saveBoard(v, { waiting_reasons: [] });
            }
          }}
          className="text-[11px] px-1.5 py-1 rounded border border-gray-200 bg-white text-ink-slate flex-1 min-w-0 disabled:opacity-60"
        >
          <option value="in_progress">In progress</option>
          <option value="stuck">Blocked (this month)</option>
          <option value="waiting_client">Waiting on client</option>
          <option value="ready_for_review">Ready for manager review</option>
          <option value="completed">✓ Completed</option>
        </select>
        {isSenior && (
          <button
            onClick={toggleBs}
            disabled={togglingBs}
            title={bsOff ? "P&L-only — click to turn the Balance Sheet back on" : "Full service — click to switch to P&L-only (BS cleanup still in progress)"}
            className={`text-[10px] font-bold px-1.5 py-1 rounded border flex-shrink-0 disabled:opacity-50 ${
              bsOff
                ? "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100"
                : "border-gray-200 text-ink-light hover:text-navy hover:bg-gray-50"
            }`}
          >
            {togglingBs ? "…" : "BS"}
          </button>
        )}
        {saving && <Loader2 size={12} className="animate-spin text-ink-light flex-shrink-0" />}
      </div>

      {/* Assign to bookkeeper — admin/lead only */}
      {isSenior && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-[10px] text-ink-light flex-shrink-0">Assigned</span>
          <select
            value={client.assigned_bookkeeper_id || ""}
            disabled={assigning}
            onChange={(e) => assignTo(e.target.value)}
            title="Assign this client to a bookkeeper"
            className="text-[11px] px-1.5 py-1 rounded border border-gray-200 bg-white text-ink-slate flex-1 min-w-0 disabled:opacity-60"
          >
            <option value="">Unassigned</option>
            {bookkeepers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.full_name}
              </option>
            ))}
          </select>
          {assigning && <Loader2 size={12} className="animate-spin text-ink-light flex-shrink-0" />}
        </div>
      )}

      {/* Waiting-on-client reason editor */}
      {editing && (
        <div className="mt-2 p-2 rounded-lg bg-amber-50/60 border border-amber-200 space-y-1.5">
          {WAITING_REASONS.map((w) => (
            <label key={w.id} className="flex items-center gap-2 text-[11px] text-navy cursor-pointer">
              <input
                type="checkbox"
                checked={reasons.includes(w.id)}
                onChange={(e) =>
                  setReasons((prev) =>
                    e.target.checked ? [...prev, w.id] : prev.filter((x) => x !== w.id)
                  )
                }
                className="w-3.5 h-3.5 rounded border-gray-300 text-amber-600"
              />
              {w.label}
            </label>
          ))}
          <label className="flex items-center gap-2 text-[11px] font-semibold text-purple-800 cursor-pointer pt-1 border-t border-amber-200/60">
            <input
              type="checkbox"
              checked={false}
              onChange={() => {
                // Not a stored reason — this is the submit gate. Open the
                // full review flow (statements must be attested first).
                setEditing(false);
                onSelect();
                if (!run?.checks_ran_at || !run?.statements) {
                  alert(
                    "Ready for manager review = submitting the month. Run the checks and complete the statement review below first — the Submit button is at the end of that flow."
                  );
                }
              }}
              className="w-3.5 h-3.5 rounded border-gray-300 text-purple-600"
            />
            Ready for manager review →
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            maxLength={300}
            className="w-full text-[11px] px-2 py-1 rounded border border-amber-200 bg-white"
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => saveBoard("waiting_client")}
              disabled={saving}
              className="text-[11px] font-bold px-2.5 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Save
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

      {isPending && run?.has_concerns && (
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-800">
          <AlertCircle size={10} />
          Concerns noted for the manager
        </div>
      )}

    </div>
  );
}
