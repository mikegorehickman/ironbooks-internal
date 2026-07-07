"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, Loader2, MessageCircleQuestion, Sparkles, X } from "lucide-react";
import type { ClientAnswerRow } from "@/lib/client-answers";

/**
 * Client answers — ask-client transaction questions the client has answered.
 * Default action is one-click Approve (applies their pick straight to QBO);
 * the dropdown offers AI-suggested similar accounts (client picked
 * "Subcontractors" → the labor options) plus their full P&L chart. Reject
 * sends the row back to needs_review on the reclass job.
 */

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ClientAnswersWidget({ rows: initial }: { rows: ClientAnswerRow[] }) {
  const [rows, setRows] = useState(initial);
  const [bulk, setBulk] = useState<{ client: string; done: number; total: number } | null>(null);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);

  // Approve every answered row for one client, sequentially (QBO rate
  // limits + per-row live guards). Note-only rows are skipped — they need
  // a human account pick.
  async function approveAll(client: string, list: ClientAnswerRow[]) {
    const targets = list.filter((r) => r.answer_account);
    if (targets.length === 0) return;
    if (
      !confirm(
        `Approve all ${targets.length} client answer${targets.length === 1 ? "" : "s"} for ${client}?\n\n` +
          `Each one applies the client's pick straight to QuickBooks.` +
          (targets.length < list.length
            ? `\n(${list.length - targets.length} note-only answer${list.length - targets.length === 1 ? "" : "s"} will stay — they need you to pick the account.)`
            : "")
      )
    )
      return;
    setBulk({ client, done: 0, total: targets.length });
    setBulkErrors([]);
    const errs: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      try {
        const res = await fetch(`/api/today/client-answers/${r.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setRows((p) => p.filter((x) => x.id !== r.id));
      } catch (e: any) {
        errs.push(`${r.vendor || r.description || r.id}: ${e?.message || "failed"}`);
      }
      setBulk({ client, done: i + 1, total: targets.length });
    }
    setBulkErrors(errs);
    setBulk(null);
  }

  if (rows.length === 0 && bulkErrors.length === 0) return null;

  const byClient = new Map<string, ClientAnswerRow[]>();
  for (const r of rows) {
    const arr = byClient.get(r.client_name) || [];
    arr.push(r);
    byClient.set(r.client_name, arr);
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
        <MessageCircleQuestion size={15} className="text-teal" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
          Client answers ({rows.length})
        </h2>
        <span className="text-[11px] text-ink-light">
          the client answered a transaction question — confirm to apply
        </span>
      </div>
      <div className="divide-y divide-gray-50">
        {bulkErrors.length > 0 && (
          <div className="px-5 py-2 text-xs text-red-800 bg-red-50 border-b border-red-100">
            {bulkErrors.length} failed (still listed below): {bulkErrors.slice(0, 3).join(" · ")}
            {bulkErrors.length > 3 ? "…" : ""}
          </div>
        )}
        {[...byClient.entries()].map(([client, list]) => (
          <div key={client}>
            <div className="px-5 pt-3 pb-1 flex items-center gap-2">
              <span className="text-xs font-bold text-ink-slate">{client}</span>
              {list.filter((r) => r.answer_account).length > 1 && (
                <button
                  onClick={() => approveAll(client, list)}
                  disabled={!!bulk}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-teal border border-teal/30 hover:bg-teal/5 rounded-md px-2 py-0.5 disabled:opacity-50"
                >
                  {bulk?.client === client ? (
                    <>
                      <Loader2 size={10} className="animate-spin" /> {bulk.done}/{bulk.total}…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={10} /> Approve all {list.filter((r) => r.answer_account).length}
                    </>
                  )}
                </button>
              )}
            </div>
            {list.map((r) => (
              <AnswerRow key={r.id} row={r} onDone={(id) => setRows((p) => p.filter((x) => x.id !== id))} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function AnswerRow({ row, onDone }: { row: ClientAnswerRow; onDone: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(row.error || "");
  const [open, setOpen] = useState(false);
  const [sugg, setSugg] = useState<Array<{ id: string; name: string; reason: string }> | null>(null);
  const [all, setAll] = useState<Array<{ id: string; name: string }>>([]);
  const [pickOther, setPickOther] = useState("");

  async function act(body: any, busyKey: string) {
    setBusy(busyKey);
    setError("");
    try {
      const res = await fetch(`/api/today/client-answers/${row.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
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
        if (res.ok) {
          setSugg(j.suggestions || []);
          setAll(j.all || []);
        } else {
          setSugg([]);
        }
      } catch {
        setSugg([]);
      }
    }
  }

  function reject() {
    const note = window.prompt("Why reject? (optional — goes on the reclass row)");
    if (note === null) return;
    act({ action: "reject", note: note.trim() || undefined }, "reject");
  }

  return (
    <div className="px-5 py-3">
      <div className="flex items-start gap-3 flex-wrap">
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
          {error && <div className="text-xs text-red-700 mt-1">{error}</div>}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {row.answer_account ? (
            <button
              onClick={() => act({ action: "approve" }, "approve")}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 text-xs font-bold bg-teal hover:bg-teal-dark text-white rounded-l-lg px-3 py-2 disabled:opacity-50"
            >
              {busy === "approve" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Approve
            </button>
          ) : (
            <button
              onClick={toggleDropdown}
              className="inline-flex items-center gap-1.5 text-xs font-bold bg-teal hover:bg-teal-dark text-white rounded-l-lg px-3 py-2"
            >
              Pick account
            </button>
          )}
          <button
            onClick={toggleDropdown}
            disabled={!!busy}
            title="Apply as a different account"
            className="inline-flex items-center text-xs font-bold bg-teal/90 hover:bg-teal-dark text-white rounded-r-lg px-1.5 py-2 border-l border-white/30 disabled:opacity-50"
          >
            <ChevronDown size={13} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
          </button>
          <button
            onClick={reject}
            disabled={!!busy}
            className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-red-700 border border-gray-200 hover:border-red-200 rounded-lg px-2.5 py-2 disabled:opacity-50"
          >
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
            <div className="text-xs text-ink-slate flex items-center gap-1.5 py-1">
              <Loader2 size={12} className="animate-spin" /> finding similar accounts…
            </div>
          ) : sugg.length === 0 ? (
            <div className="text-xs text-ink-light py-1">No close matches — use the full chart below.</div>
          ) : (
            sugg.map((s) => (
              <button
                key={s.id}
                onClick={() => act({ action: "approve_as", account_id: s.id, account_name: s.name }, s.id)}
                disabled={!!busy}
                className="w-full flex items-center gap-2 text-left text-xs rounded-lg border border-gray-200 bg-white hover:border-teal px-2.5 py-1.5 disabled:opacity-50"
              >
                {busy === s.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} className="text-teal" />}
                <span className="font-semibold text-navy">{s.name}</span>
                <span className="text-ink-light">{s.reason}</span>
              </button>
            ))
          )}
          {all.length > 0 && (
            <div className="flex items-center gap-1.5 pt-1">
              <select
                value={pickOther}
                onChange={(e) => setPickOther(e.target.value)}
                className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-ink-slate"
              >
                <option value="">Full chart of accounts…</option>
                {all.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <button
                onClick={() => {
                  const acc = all.find((a) => a.id === pickOther);
                  if (acc) act({ action: "approve_as", account_id: acc.id, account_name: acc.name }, "other");
                }}
                disabled={!pickOther || !!busy}
                className="text-xs font-bold text-teal border border-teal/30 hover:bg-teal/5 rounded-lg px-2.5 py-1.5 disabled:opacity-40"
              >
                {busy === "other" ? <Loader2 size={11} className="animate-spin" /> : "Apply"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
