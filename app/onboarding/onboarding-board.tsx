"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail, FileText, CalendarCheck, CheckCircle2, Clock, Loader2, UserPlus,
  ArrowRight, AlertTriangle, X, RefreshCw,
} from "lucide-react";
import { deriveStage, slaLevel, type OnboardingLead, type OnboardingStage } from "@/lib/onboarding";

interface Bk { id: string; full_name: string }

const COLUMNS: { stage: OnboardingStage; title: string; hint: string }[] = [
  { stage: "new_sale", title: "New sale", hint: "Won — onboarding not started" },
  { stage: "in_progress", title: "In onboarding", hint: "Form or call in progress" },
  { stage: "ready", title: "Ready to onboard", hint: "Form done + call attended" },
];

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function OnboardingBoard({ leads, bookkeepers }: { leads: OnboardingLead[]; bookkeepers: Bk[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  async function syncGhl(since?: string) {
    setSyncing(true);
    setSyncResult(null);
    setError("");
    try {
      const res = await fetch("/api/onboarding/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(since ? { since } : {}),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const { added, updated, total } = data;
      setSyncResult(
        total === 0
          ? "No won opportunities found — check GHL env vars."
          : `Synced ${total} opportunities: ${added} new, ${updated} updated.`
      );
      if (added > 0) router.refresh();
    } catch (e: any) {
      setError(e.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function act(id: string, action: string, extra: Record<string, any> = {}) {
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(`/api/onboarding/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (action === "create_client" && data.client_link_id) {
        // straight into the work: the lead is converted, cleanup starts now
        window.location.href = "/board?pipeline=cleanup";
        return;
      }
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const byStage = (s: OnboardingStage) => leads.filter((l) => deriveStage(l) === s);
  const bkName = (id: string | null) => bookkeepers.find((b) => b.id === id)?.full_name || null;

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => syncGhl()}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-gray-50 disabled:opacity-50"
          title="Pull won opportunities from GHL and add any that are missing"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Sync GHL
        </button>
        <button
          onClick={() => {
            const since = prompt("Backfill from date (YYYY-MM-DD):", new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0]);
            if (since) syncGhl(since);
          }}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-ink-slate hover:bg-gray-50 disabled:opacity-50"
          title="Pull won opportunities back to a specific date — use for first-time backfill"
        >
          Backfill…
        </button>
        {syncResult && (
          <span className="text-sm text-emerald-700 font-medium">{syncResult}</span>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}
      {leads.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
          <div className="inline-flex w-14 h-14 rounded-full bg-teal-lighter items-center justify-center mb-3">
            <UserPlus className="text-teal" size={24} />
          </div>
          <h2 className="text-lg font-bold text-navy">No onboarding leads yet</h2>
          <p className="text-sm text-ink-slate max-w-md mx-auto mt-1 leading-relaxed">
            New sales land here automatically when a deal is marked Won in GHL. Once the webhooks are
            connected, every new client will appear and move across as they complete the onboarding
            form and book their call.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {COLUMNS.map((col) => {
            const items = byStage(col.stage);
            return (
              <div key={col.stage} className="bg-[#E9ECF1] rounded-2xl p-2.5">
                <div className="px-2 py-1.5 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-navy">{col.title}</h2>
                    <p className="text-[11px] text-ink-light">{col.hint}</p>
                  </div>
                  <span className="text-xs font-bold text-ink-slate bg-white rounded-full px-2 py-0.5 border border-gray-200">
                    {items.length}
                  </span>
                </div>
                <div className="space-y-2 mt-1">
                  {items.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      stage={col.stage}
                      bookkeepers={bookkeepers}
                      bkName={bkName}
                      busy={busyId === lead.id}
                      onAct={act}
                    />
                  ))}
                  {items.length === 0 && (
                    <div className="text-center text-[11px] text-ink-light py-6">Nothing here</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  stage,
  bookkeepers,
  bkName,
  busy,
  onAct,
}: {
  lead: OnboardingLead;
  stage: OnboardingStage;
  bookkeepers: Bk[];
  bkName: (id: string | null) => string | null;
  busy: boolean;
  onAct: (id: string, action: string, extra?: Record<string, any>) => void;
}) {
  const sla = slaLevel(lead);
  const wonDays = daysAgo(lead.won_at);
  const formDone = !!lead.ob_form_submitted_at;
  const callAttended = !!lead.ob_call_attended_at || lead.ob_call_status === "attended";
  const callBooked = !!lead.ob_call_time && lead.ob_call_status !== "cancelled" && !callAttended;
  const callCancelled = lead.ob_call_status === "cancelled";

  const accent =
    sla === "overdue" ? "border-l-4 border-l-red-700" : sla === "warn" ? "border-l-4 border-l-red-400" : "border-l-4 border-l-transparent";

  return (
    <div className={`bg-white rounded-xl border border-gray-200 ${accent} p-3 relative`}>
      {busy && (
        <div className="absolute inset-0 bg-white/60 rounded-xl flex items-center justify-center z-10">
          <Loader2 className="animate-spin text-teal" size={18} />
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-sm text-navy truncate">{lead.business_name || lead.full_name || "New lead"}</div>
          {lead.business_name && lead.full_name && (
            <div className="text-[11px] text-ink-slate truncate">{lead.full_name}</div>
          )}
          {lead.email && <div className="text-[11px] text-ink-light truncate">{lead.email}</div>}
        </div>
        {wonDays !== null && (
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
              sla === "overdue" ? "bg-red-100 text-red-800" : sla === "warn" ? "bg-red-50 text-red-700" : "bg-gray-50 text-ink-light"
            }`}
            title={`Won ${fmtDate(lead.won_at)}`}
          >
            {wonDays === 0 ? "today" : `${wonDays}d`}
          </span>
        )}
      </div>

      {/* Milestone checklist */}
      <div className="mt-2.5 space-y-1 text-[11px]">
        <div className={`flex items-center gap-1.5 ${formDone ? "text-emerald-700" : "text-ink-light"}`}>
          {formDone ? <CheckCircle2 size={12} /> : <FileText size={12} />}
          <span>{formDone ? `Form done · ${fmtDate(lead.ob_form_submitted_at)}` : "Onboarding form pending"}</span>
        </div>
        <div
          className={`flex items-center gap-1.5 ${
            callAttended ? "text-emerald-700" : callCancelled ? "text-red-600" : callBooked ? "text-navy" : "text-ink-light"
          }`}
        >
          {callAttended ? <CheckCircle2 size={12} /> : callBooked ? <CalendarCheck size={12} /> : <Clock size={12} />}
          <span>
            {callAttended
              ? "Call attended"
              : callCancelled
              ? "Call cancelled — rebook"
              : callBooked
              ? `Call ${fmtDateTime(lead.ob_call_time)}`
              : "Call not booked"}
          </span>
        </div>
      </div>

      {/* Owner */}
      <div className="mt-2.5">
        <select
          value={lead.assigned_to || ""}
          onChange={(e) => onAct(lead.id, "assign", { assigned_to: e.target.value || null })}
          className="w-full text-[11px] rounded-md border border-gray-200 px-1.5 py-1 text-navy bg-white"
          title="Assign owner"
        >
          <option value="">Unassigned</option>
          {bookkeepers.map((b) => (
            <option key={b.id} value={b.id}>{b.full_name}</option>
          ))}
        </select>
      </div>

      {/* Actions */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <button
          onClick={() => onAct(lead.id, "resend")}
          className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded bg-slate-50 text-ink-slate hover:bg-slate-100 border border-gray-200"
          title="Re-send the onboarding email (form + booking link)"
        >
          <Mail size={11} /> Resend
        </button>
        {callBooked && (
          <button
            onClick={() => onAct(lead.id, "mark_attended")}
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
          >
            <CheckCircle2 size={11} /> Mark attended
          </button>
        )}
        {stage === "ready" && (
          <button
            onClick={() => {
              if (confirm(`Start cleanup for ${lead.business_name || lead.full_name}? Their account moves to the Cleanup board (created now if the onboarding form didn't already create it).`))
                onAct(lead.id, "create_client");
            }}
            className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded bg-teal text-white hover:bg-teal-dark"
          >
            <UserPlus size={11} /> Start cleanup <ArrowRight size={10} />
          </button>
        )}
        <button
          onClick={() => {
            const reason = prompt(`Mark ${lead.business_name || lead.full_name} as lost? Optional reason:`);
            if (reason !== null) onAct(lead.id, "mark_lost", { lost_reason: reason });
          }}
          className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded text-ink-light hover:text-red-600 hover:bg-red-50 border border-transparent"
          title="Mark lost / remove from board"
        >
          <X size={11} /> Lost
        </button>
      </div>

      {sla !== "ok" && (
        <div className="mt-2 flex items-center gap-1 text-[10px] font-semibold text-red-700">
          <AlertTriangle size={11} /> {sla === "overdue" ? "Stalled 5+ days — chase now" : "Stalling — no movement in 3+ days"}
        </div>
      )}
    </div>
  );
}
