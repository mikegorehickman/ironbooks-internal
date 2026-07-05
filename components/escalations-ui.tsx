"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Flag, Loader2, CheckCircle2, AlertTriangle, ChevronDown } from "lucide-react";
import { AGING_MS } from "@/lib/client-attention-state";

/**
 * Escalation UI, shared by every board:
 *
 *  <EscalateMenu>       — the two-click raise: note first, then a pre-baked
 *                         reason picker (picking a reason sends). Feels like
 *                         tagging, not process. A duplicate raise folds the
 *                         new note into the existing escalation and says so.
 *  <EscalationStrip>    — thin red board-top strip ("⚠ 2 escalated: …");
 *                         clicking opens the list ON the board — triage
 *                         never requires leaving the page. Recently resolved
 *                         escalations linger for 7 days with their answer, so
 *                         the person who raised one sees what was decided.
 *
 * Data comes from /api/escalations; boards refresh via onChanged().
 */

export const ESCALATION_REASONS = [
  { kind: "general", label: "Needs senior review" },
  { kind: "billing", label: "Billing issue" },
  { kind: "client_relationship", label: "Client relationship" },
] as const;

export interface EscalationRow {
  id: string;
  client_link_id: string;
  client_name: string;
  kind: string;
  reason: string;
  note: string | null;
  status: "open" | "resolved";
  raised_by_name: string | null;
  resolved_by_name?: string | null;
  resolution_note?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

const RESOLVED_WINDOW_MS = 7 * 24 * 3_600_000;

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/** Two-click raise: flag button → optional note + reason picker (reason sends). */
export function EscalateMenu({
  clientLinkId,
  clientName,
  onRaised,
  small,
}: {
  clientLinkId: string;
  clientName: string;
  onRaised: () => void;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");

  function close() {
    setOpen(false);
    setNote("");
    setInfo("");
    setError("");
  }

  async function raise(reason: string, kind: string) {
    setBusy(reason);
    setError("");
    try {
      const res = await fetch("/api/escalations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          reason,
          kind,
          note: note.trim() || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.deduped) {
        // Folded into an existing open escalation — tell the raiser instead
        // of pretending a new one was created.
        setInfo("Already escalated — your note was added to it.");
        setTimeout(() => {
          close();
          onRaised();
        }, 1800);
      } else {
        close();
        onRaised();
      }
    } catch (e: any) {
      setError(e?.message || "Couldn't escalate");
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={`Escalate ${clientName} to a senior`}
        className={`inline-flex items-center gap-1 rounded border border-gray-200 text-ink-light hover:text-red-700 hover:border-red-300 hover:bg-red-50 ${
          small ? "px-1 py-0.5 text-[10px]" : "px-1.5 py-1 text-[11px]"
        }`}
      >
        <Flag size={small ? 10 : 12} />
        {!small && "Escalate"}
      </button>
      {open && (
        <>
          {/* click-outside dismiss */}
          <div
            className="fixed inset-0 z-30 cursor-default"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
          />
          <div
            className="absolute right-0 top-full mt-1 z-40 w-64 bg-white rounded-xl border border-gray-200 shadow-xl p-2.5 space-y-2 cursor-default text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light">
              Escalate {clientName}
            </div>
            {info ? (
              <div className="text-xs font-semibold text-emerald-700 py-1">{info}</div>
            ) : (
              <>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add context (optional) — picking a reason sends"
                  maxLength={500}
                  className="w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200"
                />
                <div className="flex flex-col gap-1">
                  {ESCALATION_REASONS.map((r) => (
                    <button
                      key={r.label}
                      onClick={() => raise(r.label, r.kind)}
                      disabled={!!busy}
                      className="flex items-center gap-1.5 text-left text-xs font-semibold text-navy rounded-lg border border-gray-100 hover:border-red-200 hover:bg-red-50 px-2 py-1.5 disabled:opacity-50"
                    >
                      {busy === r.label ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Flag size={11} className="text-red-500" />
                      )}
                      {r.label}
                    </button>
                  ))}
                </div>
                {error && <div className="text-[10px] text-red-700">{error}</div>}
                <button onClick={close} className="text-[10px] text-ink-light hover:text-navy">
                  Cancel
                </button>
              </>
            )}
          </div>
        </>
      )}
    </span>
  );
}

/** Board-top strip + on-board list. Hidden when the board has nothing to show. */
export function EscalationStrip({
  clientIds,
  onChanged,
  alwaysOpen = false,
}: {
  /** Scope the strip to this board's clients; null = all. */
  clientIds: string[] | null;
  /** Called after a resolve so the parent board can refresh badges. */
  onChanged?: () => void;
  /** /approvals mode: list always expanded, empty + error states shown. */
  alwaysOpen?: boolean;
}) {
  const [rows, setRows] = useState<EscalationRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(alwaysOpen);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/escalations?status=all");
      const j = await res.json();
      if (res.ok) {
        setRows(j.escalations || []);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const scoped = clientIds ? rows.filter((r) => clientIds.includes(r.client_link_id)) : rows;
  // Oldest first — the escalation most at risk of rotting sits on top.
  const openRows = scoped
    .filter((r) => r.status === "open")
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  // Resolved answers linger for a week so the raiser sees what was decided.
  const resolvedRows = scoped
    .filter(
      (r) =>
        r.status === "resolved" &&
        r.resolved_at &&
        Date.now() - new Date(r.resolved_at).getTime() < RESOLVED_WINDOW_MS
    )
    .sort((a, b) => ((a.resolved_at || "") > (b.resolved_at || "") ? -1 : 1));

  if (failed && alwaysOpen) {
    return (
      <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        Couldn&apos;t load escalations — refresh to retry.
      </div>
    );
  }
  if (openRows.length === 0 && resolvedRows.length === 0) {
    if (alwaysOpen) {
      return (
        <div className="mb-3 rounded-lg border border-gray-100 bg-white px-3 py-2 text-xs text-ink-slate">
          No open escalations.
        </div>
      );
    }
    return null;
  }

  async function resolve(id: string) {
    const note = window.prompt("Resolution note (optional):");
    if (note === null) return; // Cancel aborts — it never resolves.
    setBusyId(id);
    try {
      const res = await fetch(`/api/escalations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", resolution_note: note.trim() || undefined }),
      });
      if (res.ok) {
        await load();
        onChanged?.();
      }
    } finally {
      setBusyId(null);
    }
  }

  const headerOpen = openRows.length > 0;

  return (
    <div className="mb-3">
      <button
        onClick={() => !alwaysOpen && setOpen((o) => !o)}
        className={`w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-left ${
          headerOpen
            ? `border-red-300 bg-red-50 ${alwaysOpen ? "cursor-default" : "hover:bg-red-100/70"}`
            : `border-emerald-200 bg-emerald-50/60 ${alwaysOpen ? "cursor-default" : "hover:bg-emerald-50"}`
        }`}
      >
        {headerOpen ? (
          <>
            <AlertTriangle size={14} className="text-red-700 flex-shrink-0" />
            <strong className="text-red-900">{openRows.length} escalated</strong>
            <span className="text-red-800 truncate">
              {openRows.slice(0, 4).map((r) => r.client_name).join(", ")}
              {openRows.length > 4 ? "…" : ""}
            </span>
          </>
        ) : (
          <>
            <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0" />
            <span className="text-emerald-900">
              {resolvedRows.length} escalation{resolvedRows.length === 1 ? "" : "s"} resolved this
              week — see what was decided
            </span>
          </>
        )}
        {!alwaysOpen && (
          <ChevronDown
            size={14}
            className={`ml-auto flex-shrink-0 transition-transform ${
              headerOpen ? "text-red-700" : "text-emerald-700"
            } ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open && (
        <ul className="mt-1.5 rounded-lg border border-gray-200 bg-white divide-y divide-gray-50 overflow-hidden">
          {openRows.map((r) => {
            const aging = Date.now() - new Date(r.created_at).getTime() > AGING_MS;
            return (
              <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
                <Flag
                  size={13}
                  className={`flex-shrink-0 mt-0.5 ${aging ? "text-red-600" : "text-ink-light"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/clients/${r.client_link_id}`}
                      className="text-sm font-semibold text-navy hover:underline"
                    >
                      {r.client_name}
                    </Link>
                    <span className="text-xs text-red-800 font-medium">{r.reason}</span>
                    <span
                      className={
                        aging ? "text-[10px] font-bold text-red-700" : "text-[10px] text-ink-light"
                      }
                    >
                      {ago(r.created_at)}
                      {r.raised_by_name ? ` · by ${r.raised_by_name}` : ""}
                    </span>
                  </div>
                  {r.note && (
                    <div className="text-xs text-ink-slate mt-0.5 whitespace-pre-line">{r.note}</div>
                  )}
                </div>
                <button
                  onClick={() => resolve(r.id)}
                  disabled={busyId === r.id}
                  className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-lg px-2.5 py-1.5 flex-shrink-0"
                >
                  {busyId === r.id ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <CheckCircle2 size={11} />
                  )}
                  Resolve
                </button>
              </li>
            );
          })}
          {resolvedRows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2.5 bg-gray-50/60 opacity-80">
              <CheckCircle2 size={13} className="flex-shrink-0 mt-0.5 text-emerald-600" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/clients/${r.client_link_id}`}
                    className="text-sm font-semibold text-ink-slate hover:underline"
                  >
                    {r.client_name}
                  </Link>
                  <span className="text-xs text-ink-slate">{r.reason}</span>
                  <span className="text-[10px] text-ink-light">
                    resolved {r.resolved_at ? ago(r.resolved_at) : ""}
                    {r.resolved_by_name ? ` by ${r.resolved_by_name}` : ""}
                  </span>
                </div>
                {r.resolution_note && (
                  <div className="text-xs text-emerald-800 mt-0.5">→ {r.resolution_note}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
