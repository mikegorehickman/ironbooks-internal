"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2, ChevronRight, Undo2, AlertTriangle, CheckCircle2, RefreshCw,
} from "lucide-react";

/**
 * Client list + per-client revert plan. Flow per client:
 *   1. "Load plan" — read-only classification (safe / activity / ambiguous)
 *   2. Review the lists
 *   3. "Revert N accounts" — confirm dialog → the write (safe accounts only,
 *      children first). Plan is rebuilt server-side at execute time.
 */

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round((n || 0) * 100) / 100).toLocaleString();

interface ClientRow {
  client_link_id: string;
  client_name: string;
  created_count: number;
  is_active: boolean;
  has_qbo: boolean;
  last_applied_at: string;
}

export function RevertClient() {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/coa-fleet-revert")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else setClients(j.clients || []);
      })
      .catch((e) => setError(e?.message || "Failed to load"));
  }, []);

  if (error) {
    return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>;
  }
  if (!clients) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-slate py-8 justify-center">
        <Loader2 size={16} className="animate-spin text-teal" /> Loading clients from the audit log…
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {clients.map((c) => (
        <ClientRevertCard key={c.client_link_id} client={c} />
      ))}
    </div>
  );
}

function ClientRevertCard({ client }: { client: ClientRow }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: string, extra: any = {}) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/admin/coa-fleet-revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: client.client_link_id, action, ...extra }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    } catch (e: any) {
      setError(e?.message || "Failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function loadPlan() {
    setResult(null);
    const j = await call("plan");
    if (j) setPlan(j.plan);
  }

  async function execute() {
    if (!plan) return;
    if (
      !confirm(
        `Revert ${client.client_name}?\n\n` +
          `Inactivates ${plan.safe.length} empty account${plan.safe.length === 1 ? "" : "s"} created by the fleet push. ` +
          `${plan.activity.length} account(s) with activity are NOT touched.\n\nThis writes to their live QuickBooks.`
      )
    )
      return;
    const j = await call("execute", { dry_run: false });
    if (j) {
      setResult(j.result);
      setPlan(j.plan);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open && !plan) loadPlan();
        }}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight size={15} className={`text-ink-light transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="font-semibold text-navy flex-1">{client.client_name}</span>
        {!client.is_active && (
          <span className="text-[10px] font-bold bg-gray-100 text-ink-slate px-1.5 py-0.5 rounded">INACTIVE CLIENT</span>
        )}
        <span className="text-xs text-ink-slate tabular-nums">
          {client.created_count} account{client.created_count === 1 ? "" : "s"} created
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3">
          {busy === "plan" && (
            <div className="flex items-center gap-2 text-sm text-ink-slate py-3">
              <Loader2 size={14} className="animate-spin text-teal" /> Checking each account&apos;s current QBO state…
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 mb-2">
              {error}
              {/(expired|disconnected)/i.test(error) && (
                <span> — reconnect QBO from the <Link className="underline font-semibold" href={`/clients/${client.client_link_id}`}>client page</Link> first.</span>
              )}
            </div>
          )}

          {plan && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-4 text-xs">
                <Pill label="Safe to remove" n={plan.safe.length} tone="emerald" />
                <Pill label="Has activity — kept" n={plan.activity.length} tone="amber" />
                <Pill label="Ambiguous — kept" n={plan.ambiguous.length} tone="amber" />
                <Pill label="Already gone" n={plan.gone.length} tone="gray" />
              </div>

              {plan.activity.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                  <div className="text-xs font-bold text-amber-900 flex items-center gap-1.5 mb-1">
                    <AlertTriangle size={12} /> Step 2 — postings landed on these since Jul 11. Move them to
                    the right account, then the account retires automatically.
                  </div>
                  <p className="text-[11px] text-amber-800 mb-2">
                    Real transactions are line-reclassed (detail preserved); anything QBO won&apos;t let us
                    line-edit is swept by JE. Pick where each account&apos;s postings belong — usually the
                    client&apos;s original account for that kind of expense.
                  </p>
                  <ul className="space-y-1.5">
                    {plan.activity.map((a: any) => (
                      <DrainRow
                        key={a.id}
                        account={a}
                        targets={plan.targets || []}
                        busy={busy}
                        onDrain={async (targetId: string) => {
                          if (
                            !confirm(
                              `Move everything on "${a.name}" to the selected account, then remove "${a.name}"?\n\nThis writes to ${client.client_name}'s live QuickBooks.`
                            )
                          )
                            return;
                          const j = await call("drain", { account_id: a.id, target_account_id: targetId });
                          if (j) await loadPlan();
                        }}
                      />
                    ))}
                  </ul>
                </div>
              )}

              {plan.safe.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer select-none text-xs font-semibold text-ink-slate hover:text-navy list-none">
                    ▸ The {plan.safe.length} empty accounts that would be inactivated
                  </summary>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {plan.safe.map((s: any) => (
                      <span key={s.id} className="text-[10px] bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-ink-slate">
                        {s.fq || s.name}
                      </span>
                    ))}
                  </div>
                </details>
              )}

              {result ? (
                <div className={`rounded-lg border px-3 py-2 text-sm ${result.failed.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
                  <div className="font-bold flex items-center gap-1.5">
                    <CheckCircle2 size={14} />
                    Reverted — {result.inactivated.length} inactivated{result.failed.length ? `, ${result.failed.length} failed` : ""}
                  </div>
                  {result.failed.map((f: any) => (
                    <div key={f.id} className="text-[11px] mt-0.5">{f.name}: {f.error}</div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={execute}
                    disabled={!!busy || plan.safe.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#954E44] px-3.5 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {busy === "execute" ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                    Revert {plan.safe.length} account{plan.safe.length === 1 ? "" : "s"}
                  </button>
                  <button
                    onClick={loadPlan}
                    disabled={!!busy}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-50"
                  >
                    <RefreshCw size={12} /> Re-check
                  </button>
                  {plan.safe.length === 0 && (
                    <span className="text-xs text-ink-slate">Nothing safely removable.</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One step-2 row: an activity account + a target picker + the drain button.
 * Targets default to the same classification (an Expense drains into an
 * Expense); "show all" lifts the filter for the odd cross-type case.
 */
function DrainRow({
  account,
  targets,
  busy,
  onDrain,
}: {
  account: any;
  targets: any[];
  busy: string | null;
  onDrain: (targetId: string) => Promise<void>;
}) {
  const [targetId, setTargetId] = useState("");
  const [showAll, setShowAll] = useState(false);
  const filtered = showAll || !account.classification
    ? targets
    : targets.filter((t) => t.classification === account.classification);

  return (
    <li className="rounded-lg border border-amber-200 bg-white px-2.5 py-2">
      <div className="text-[12px] font-semibold text-navy">
        {account.name}{" "}
        <span className="font-normal text-amber-800">
          ({account.type}{account.balance ? ` · bal ${fmt(account.balance)}` : ""}{account.posted ? " · has postings" : " · blocked parent"})
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-ink-slate shrink-0">Move postings to</span>
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="text-[11px] px-1.5 py-1 rounded border border-gray-200 bg-white text-navy max-w-[260px] flex-1 min-w-[160px]"
        >
          <option value="">— pick the client&apos;s own account —</option>
          {filtered.map((t) => (
            <option key={t.id} value={t.id}>
              {t.fq || t.name} ({t.type})
            </option>
          ))}
        </select>
        <label className="text-[10px] text-ink-light inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          all types
        </label>
        <button
          onClick={() => targetId && onDrain(targetId)}
          disabled={!targetId || !!busy}
          className="inline-flex items-center gap-1 rounded bg-[#954E44] px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90 disabled:opacity-40"
        >
          {busy === "drain" ? <Loader2 size={10} className="animate-spin" /> : <Undo2 size={10} />}
          Move &amp; remove
        </button>
      </div>
    </li>
  );
}

function Pill({ label, n, tone }: { label: string; n: number; tone: "emerald" | "amber" | "gray" }) {
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : tone === "amber"
      ? "bg-amber-50 border-amber-200 text-amber-900"
      : "bg-gray-50 border-gray-200 text-ink-slate";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${cls}`}>
      <span className="tabular-nums font-bold">{n}</span> {label}
    </span>
  );
}
