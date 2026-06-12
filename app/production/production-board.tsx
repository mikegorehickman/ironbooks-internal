"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle, CalendarCheck, ChevronLeft, ChevronRight, CircleDashed,
  Loader2, MailQuestion, OctagonAlert, PlayCircle, Send, Sparkles, X,
} from "lucide-react";
import {
  ClientRecCard, EligibleRow, periodLabel, shiftPeriod,
  type EligibleClient, type ProdClient,
} from "./rec-card";

/**
 * /production — the month-by-month board for graduated clients.
 *
 * Four columns driven by monthly_rec_runs.board_status for the selected
 * period: Not Started / In Progress / Stuck / Waiting on Client. A client
 * with no run row for the month is Not Started — which is exactly how a
 * finished month "resets": completed runs drop to the Done strip, and the
 * next month has no row yet.
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

type BoardStatus = "not_started" | "in_progress" | "stuck" | "waiting_client";

const COLUMNS: { id: BoardStatus; title: string; icon: any; tone: string }[] = [
  { id: "not_started", title: "Not Started", icon: CircleDashed, tone: "border-gray-200" },
  { id: "in_progress", title: "In Progress", icon: PlayCircle, tone: "border-teal/40" },
  { id: "stuck", title: "Stuck", icon: OctagonAlert, tone: "border-red-300" },
  { id: "waiting_client", title: "Waiting on Client", icon: MailQuestion, tone: "border-amber-300" },
];

export function ProductionBoard() {
  const [period, setPeriod] = useState<string>("");
  const [production, setProduction] = useState<ProdClient[]>([]);
  const [eligible, setEligible] = useState<EligibleClient[]>([]);
  const [isSenior, setIsSenior] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function load(p?: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/monthly-rec${p ? `?period=${p}` : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPeriod(body.period);
      setProduction(body.production || []);
      setEligible(body.eligible || []);
      setIsSenior(!!body.is_senior);
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
    const byColumn: Record<BoardStatus, ProdClient[]> = {
      not_started: [],
      in_progress: [],
      stuck: [],
      waiting_client: [],
    };
    const done: ProdClient[] = [];
    for (const c of production) {
      if (c.run?.status === "complete") {
        done.push(c);
        continue;
      }
      // Submitted-for-review runs live in Waiting on Client with a purple chip
      if (c.run?.status === "pending_review") {
        byColumn.waiting_client.push(c);
        continue;
      }
      const bs = (c.run?.board_status as BoardStatus) || "not_started";
      byColumn[bs in byColumn ? bs : "not_started"].push(c);
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
        {production.length > 0 && (
          <span className="text-sm text-ink-slate">
            <strong className="text-navy">{done.length}</strong> of{" "}
            <strong className="text-navy">{production.length}</strong> done for{" "}
            {period ? periodLabel(period) : ""}
          </span>
        )}
      </div>

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
          {/* ── 4-COLUMN BOARD ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {COLUMNS.map((col) => {
              const Icon = col.icon;
              const cards = byColumn[col.id];
              return (
                <div key={col.id} className={`bg-white rounded-2xl border-2 ${col.tone} overflow-hidden`}>
                  <div className="px-3 py-2.5 border-b border-gray-100 flex items-center gap-2">
                    <Icon size={14} className="text-ink-slate" />
                    <span className="text-sm font-bold text-navy">{col.title}</span>
                    <span className="text-xs text-ink-light ml-auto">{cards.length}</span>
                  </div>
                  <div className="p-2 space-y-2 min-h-[80px]">
                    {cards.length === 0 && (
                      <div className="text-center text-[11px] text-ink-light py-4">—</div>
                    )}
                    {cards.map((c) => (
                      <BoardCard
                        key={c.id}
                        client={c}
                        period={period}
                        isSenior={isSenior}
                        selected={selectedId === c.id}
                        onSelect={() => setSelectedId(selectedId === c.id ? null : c.id)}
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
            <div className="space-y-2">
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
              <ClientRecCard
                client={selected}
                period={period}
                isSenior={isSenior}
                onChanged={() => load(period)}
              />
            </div>
          )}

          {/* ── DONE STRIP ── */}
          {done.length > 0 && (
            <div className="bg-emerald-50/60 border border-emerald-200 rounded-2xl px-4 py-3">
              <div className="text-xs font-bold text-emerald-800 mb-1.5">
                Done for {periodLabel(period)} ({done.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {done.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(selectedId === c.id ? null : c.id)}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white border border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                  >
                    {c.client_name} ✓{c.run?.has_concerns ? " ⚠" : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Ready to promote */}
      {!loading && eligible.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <h3 className="text-sm font-bold text-navy mb-1">
            Ready for production ({eligible.length})
          </h3>
          <p className="text-xs text-ink-slate mb-3">
            Cleanup complete, not yet promoted. {isSenior
              ? "Promote them and they join the monthly routine."
              : "Ask an admin or lead to promote them."}
          </p>
          <ul className="divide-y divide-slate-200/70">
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
  selected,
  onSelect,
  onChanged,
}: {
  client: ProdClient;
  period: string;
  isSenior: boolean;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
}) {
  const [togglingBs, setTogglingBs] = useState(false);
  const bsOff = client.bs_enabled === false;

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
      if (res.ok) onChanged();
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  const checksOverall = run?.checks?.overall;
  const currentStatus = isPending
    ? "waiting_client"
    : ((run?.board_status as string) || "not_started");

  return (
    <div
      className={`rounded-xl border bg-white px-3 py-2.5 ${
        selected ? "border-teal ring-1 ring-teal/30" : "border-gray-150 border-gray-200"
      }`}
    >
      <button onClick={onSelect} className="w-full text-left">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-semibold text-navy">{client.client_name}</span>
          {client.paused && (
            <span className="text-[9px] font-bold bg-gray-100 text-ink-slate px-1 py-0.5 rounded">PAUSED</span>
          )}
          {bsOff && (
            <span className="text-[9px] font-bold bg-sky-100 text-sky-800 px-1 py-0.5 rounded">P&L ONLY</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {isPending ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded">
              <Send size={9} />
              Ready for manager review
            </span>
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
          title={isPending ? "Submitted — waiting on the manager" : "Move this client"}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "waiting_client") setEditing(true);
            else saveBoard(v, { waiting_reasons: [] });
          }}
          className="text-[11px] px-1.5 py-1 rounded border border-gray-200 bg-white text-ink-slate flex-1 min-w-0 disabled:opacity-60"
        >
          <option value="not_started">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="stuck">Stuck</option>
          <option value="waiting_client">Waiting on client</option>
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
