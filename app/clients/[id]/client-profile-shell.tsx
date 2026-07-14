"use client";

import { useState, useEffect } from "react";
import { PLByMonthView } from "./pl-by-month-view";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  Activity,
  FileText,
  Scale,
  Banknote,
  ExternalLink,
  Loader2,
  ChevronRight,
  Settings as SettingsIcon,
  Clock,
  X as XIcon,
  CheckCircle2,
  XCircle,
  Plug,
  ArrowRight,
  Zap,
  Pause as PauseIcon,
  Play as PlayIcon,
  PowerOff,
  Mail,
  Building2,
  AlertTriangle,
  CreditCard,
  Trash2,
  ClipboardCheck,
  StickyNote,
  RefreshCw,
} from "lucide-react";
import { CleanupTab } from "./cleanup-tab";
import { NotesPanel } from "./notes-panel";
import { UrgentFlagButton } from "./urgent-flag-button";
import type {
  OutstandingWork,
  ActivityEvent,
  InternalSummary,
  ClientProgress,
  ProgressStage,
} from "@/lib/internal-client-profile";
import type { OverviewData, BalanceSheetSummary } from "@/lib/portal-data";
import { ClientDetailsCard } from "./client-details-card";
import { GrainSection } from "./grain-section";
import { CallTodosPanel } from "./call-todos-panel";
import { ResendLoginLink } from "./resend-login-link";
import { StatementsCard } from "./statements-card";
import { MessagesPanel } from "./messages-panel";
import { BillingTab } from "./billing-tab";

type ClientLink = {
  id: string;
  client_name: string;
  qbo_realm_id: string | null;
  industry: string | null;
  jurisdiction: string | null;
  state_province: string | null;
  status: string | null;
  last_synced_at: string | null;
  double_client_id: string | null;
  double_client_name: string | null;
  daily_recon_enabled?: boolean | null;
  daily_recon_paused?: boolean | null;
  daily_recon_paused_reason?: string | null;
  daily_recon_enabled_at?: string | null;
  cleanup_completed_at?: string | null;
  // Profile detail fields (migration 73)
  contact_first_name?: string | null;
  contact_last_name?: string | null;
  client_email?: string | null;
  client_phone?: string | null;
  legal_business_name?: string | null;
  trade_type?: string | null;
  corporate_type?: string | null;
  fiscal_year_end?: string | null;
  country?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  postal_code?: string | null;
  annual_revenue_range?: string | null;
  taxes_up_to_date?: string | null;
  prior_bookkeeper?: string | null;
  accounting_software?: string | null;
  payroll_provider?: string | null;
  employee_count_range?: string | null;
  uses_business_cards?: string | null;
  keeps_receipts?: string | null;
  bank_connected_to_software?: string | null;
  profile_updated_at?: string | null;
};

/** A client is "really linked" to Double when double_client_id is set AND
 *  isn't a "pending_" placeholder — those are created at silent-invite
 *  time before a real Double match has been picked. */
function isLinkedToDouble(cl: { double_client_id: string | null }): boolean {
  return !!cl.double_client_id && !cl.double_client_id.startsWith("pending_");
}

interface OverviewBundle {
  outstanding: OutstandingWork | null;
  activity: ActivityEvent[];
  summary: InternalSummary | null;
  progress: ClientProgress | null;
}

interface FinancialsBundle {
  /** Combined P&L (primary + comparison), banks, A/R, A/P. */
  overview: OverviewData | null;
  balanceSheet: BalanceSheetSummary | null;
  primaryRangeLabel: string;
  comparisonRangeLabel: string;
  /** Which range preset is active. Drives the date-range picker on P&L. */
  activeRangeKey: string;
  /** Current primary window bounds (YYYY-MM-DD) — prefill the custom pickers. */
  rangeStart: string;
  rangeEnd: string;
  /** False when the client hasn't connected QBO yet — financial tabs
   *  render an empty-state instead of pretending zeros. */
  hasQbo: boolean;
  /**
   * Three-state QBO health signal:
   *   "connected"      — qbo_realm_id set AND token refresh succeeded
   *   "token_expired"  — qbo_realm_id set BUT refresh threw (revoked /
   *                      100-day idle / client disconnected SNAP)
   *   "never_connected" — qbo_realm_id is null
   * Drives the QboConnectionBanner at the top of the Overview tab.
   */
  qboStatus: "connected" | "token_expired" | "never_connected";
}

/** Preset options for the range picker. Keys match the server's
 *  resolveDateRanges(). Order driven by typical bookkeeper workflow:
 *  most-recent-completed-period first. */
const RANGE_PRESETS: Array<{ key: string; label: string }> = [
  { key: "last-month", label: "Last month" },
  { key: "this-month", label: "This month" },
  { key: "last-30", label: "Last 30 days" },
  { key: "last-90", label: "Last 90 days" },
  { key: "quarter", label: "This quarter" },
  { key: "ytd", label: "YTD" },
];

export interface OnboardingProfile {
  won_at: string | null;
  ob_form_submitted_at: string | null;
  ob_call_time: string | null;
  ob_call_status: string | null;
  ob_call_attended_at: string | null;
  answers: { label: string; value: string }[];
}

interface Props {
  clientLink: ClientLink;
  actorRole: string;
  overview: OverviewBundle;
  financials: FinancialsBundle;
  onboarding?: OnboardingProfile | null;
  /** BS cleanup deferred → still owed (amber banner on Overview). */
  bsCleanupOwed?: boolean;
}

type TabId = "overview" | "cleanup" | "profile" | "billing" | "pl" | "bs" | "bank" | "notes" | "activity";

const TABS: { id: TabId; label: string; icon: any }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "cleanup", label: "Cleanup", icon: ClipboardCheck },
  { id: "profile", label: "Profile", icon: Building2 },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "pl", label: "P&L", icon: FileText },
  { id: "bs", label: "Balance Sheet", icon: Scale },
  { id: "bank", label: "Bank Balances", icon: Banknote },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "activity", label: "Activity", icon: Clock },
];

export function ClientProfileShell({ clientLink, actorRole, overview, financials, onboarding, bsCleanupOwed }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const canImpersonate = actorRole === "admin" || actorRole === "lead";

  // Drill-down drawer state — shared across P&L and BS tabs. Holds the
  // account the user clicked plus the date range to query. The drawer
  // itself owns the fetch + render so tabs stay focused on layout.
  const [drill, setDrill] = useState<{
    accountId: string;
    accountName: string;
    kind: "pl" | "bs";
    start: string;
    end: string;
  } | null>(null);

  return (
    <div className="px-8 py-6 max-w-7xl mx-auto space-y-6">
      {/* Top action bar — sits above the tab strip so the actions are visible
          from every tab without having to scroll back. "View as client" is
          the most-requested handoff so it gets the most-prominent slot. */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-ink-slate">
          {clientLink.last_synced_at && (
            <span className="text-xs">
              Last QBO sync:{" "}
              {new Date(clientLink.last_synced_at).toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/jobs/new?client=${clientLink.id}&redo=1`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal text-white text-xs font-semibold hover:bg-teal-dark"
            title="Re-run COA cleanup — applies the latest master chart and skips the redo confirmation"
          >
            <RefreshCw size={13} />
            Re-run COA Cleanup
          </Link>
          <UrgentFlagButton
            clientLinkId={clientLink.id}
            initialUrgent={!!(clientLink as any).urgent_flag}
            initialNote={(clientLink as any).urgent_flag_note || null}
          />
          <Link
            href={`/clients/${clientLink.id}/messages`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-ink-slate hover:text-navy hover:border-gray-300"
          >
            <Mail size={13} />
            Messages
          </Link>
          {canImpersonate && <ViewAsClientButton clientLinkId={clientLink.id} />}
          <ResendLoginLink clientLinkId={clientLink.id} />
          <DoubleLinkControl
            clientLinkId={clientLink.id}
            doubleName={clientLink.double_client_name}
            isLinked={isLinkedToDouble(clientLink)}
            canUnlink={actorRole === "admin" || actorRole === "lead"}
          />
          {canImpersonate && (
            <DeleteClientButton clientLinkId={clientLink.id} clientName={clientLink.client_name} />
          )}
        </div>
      </div>

      {/* Tab strip — top-level navigation between financial views. Tabs are
          stateful (no URL change) so we keep page state per tab without
          shuffling the address bar; switch to nested routes later if we
          want deep-link-per-tab. */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                active
                  ? "border-teal text-navy"
                  : "border-transparent text-ink-slate hover:text-navy hover:border-gray-200"
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      </div>

      {activeTab === "overview" && (
        <OverviewTab
          clientLink={clientLink}
          overview={overview}
          qboStatus={financials.qboStatus}
          onboarding={onboarding}
          bsCleanupOwed={bsCleanupOwed}
          canSendMessages={actorRole !== "viewer"}
        />
      )}
      {activeTab === "cleanup" && (
        <CleanupTab clientLinkId={clientLink.id} clientName={clientLink.client_name} />
      )}
      {activeTab === "profile" && (
        <ProfileTab clientLink={clientLink} onboarding={onboarding} />
      )}
      {activeTab === "billing" && <BillingTab clientLinkId={clientLink.id} />}
      {activeTab === "pl" && (
        <PLTab
          financials={financials}
          clientLinkId={clientLink.id}
          onDrill={(accountId, accountName) =>
            setDrill({
              accountId,
              accountName,
              kind: "pl",
              start: financials.overview?.primaryMonth.start || "",
              end: financials.overview?.primaryMonth.end || "",
            })
          }
        />
      )}
      {activeTab === "bs" && (
        <BSTab
          financials={financials}
          clientLinkId={clientLink.id}
          onDrill={(accountId, accountName) =>
            setDrill({
              accountId,
              accountName,
              kind: "bs",
              // BS drill defaults to last 90 days of activity hitting the
              // account — gives the bookkeeper context without flooding
              // them with multi-year history on the first click.
              start: ymdDaysAgo(90),
              end: ymdToday(),
            })
          }
        />
      )}
      {activeTab === "bank" && <BankTab financials={financials} clientLinkId={clientLink.id} />}

      {activeTab === "notes" && <NotesPanel clientLinkId={clientLink.id} />}
      {activeTab === "activity" && (
        <ActivityTab activity={overview.activity} />
      )}

      {drill && (
        <DrillDrawer
          clientLinkId={clientLink.id}
          accountId={drill.accountId}
          accountName={drill.accountName}
          kind={drill.kind}
          start={drill.start}
          end={drill.end}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// ─── DELETE CLIENT ─────────────────────────────────────────────────────
// Admin/lead control. The API hard-deletes a client with no financial
// footprint, else archives it (is_active=false) to preserve the books.
// Either way it disappears from the clients list. Two-step confirm.
function DeleteClientButton({ clientLinkId, clientName }: { clientLinkId: string; clientName: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error || "Delete failed"); setBusy(false); return; }
      router.push("/clients"); // removed → back to the list
      router.refresh();
    } catch (e: any) { setErr(e?.message || "Network error"); setBusy(false); }
  }

  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} title="Delete this client (archives if it has financial records)"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 bg-white text-xs font-semibold text-red-600 hover:bg-red-50 hover:border-red-300">
        <Trash2 size={13} /> Delete
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-xs text-red-700 font-medium">Delete {clientName}?</span>
      <button onClick={doDelete} disabled={busy}
        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-60">
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Confirm
      </button>
      <button onClick={() => { setConfirming(false); setErr(null); }} disabled={busy}
        className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-ink-slate hover:bg-gray-50">
        Cancel
      </button>
      {err && <span className="text-xs text-red-700">{err}</span>}
    </div>
  );
}

// ─── PROGRESS FLOW CHART ───────────────────────────────────────────────

function ProgressFlowChart({ progress }: { progress: ClientProgress }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-navy">Client progress</h2>
        <div className="text-xs text-ink-slate">
          <span className="font-bold text-navy">{progress.percentComplete}%</span>{" "}
          of lifecycle complete
        </div>
      </div>

      {/* Top-line progress bar — single horizontal track that fills based
          on percentComplete. Cheap visual reinforcement of the number,
          keeps the eye moving across the stage cards below. */}
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-4">
        <div
          className="h-full bg-gradient-to-r from-teal to-emerald-500 transition-all"
          style={{ width: `${progress.percentComplete}%` }}
        />
      </div>

      {/* Stage cards arranged horizontally on desktop with chevron arrows
          between them so the "flow" reads left-to-right. On narrow screens
          the cards wrap to a grid and the chevrons hide — keeps the layout
          legible without scrollbars. */}
      <div className="hidden lg:flex items-stretch gap-0">
        {progress.stages.map((stage, i) => (
          <div key={stage.key} className="flex items-stretch flex-1 min-w-0">
            <ProgressStageCard stage={stage} index={i} />
            {i < progress.stages.length - 1 && (
              <div className="flex items-center px-1 text-ink-slate/40 shrink-0">
                <ChevronRight size={18} />
              </div>
            )}
          </div>
        ))}
      </div>
      {/* Mobile/tablet fallback — 2-3 column grid, no chevrons */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 lg:hidden">
        {progress.stages.map((stage, i) => (
          <ProgressStageCard key={stage.key} stage={stage} index={i} />
        ))}
      </div>
    </section>
  );
}

function ProgressStageCard({
  stage,
  index,
}: {
  stage: ProgressStage;
  index: number;
}) {
  // Color palette per status. Pulled into a map so the inline classes
  // stay readable + Tailwind's JIT can statically detect every class
  // (no dynamic concatenation that defeats purge).
  const styles: Record<
    ProgressStage["status"],
    { card: string; pill: string; icon: string; pillText: string }
  > = {
    complete: {
      card: "bg-emerald-50 border-emerald-300 hover:border-emerald-500 hover:shadow-sm",
      pill: "bg-emerald-600",
      pillText: "Done",
      icon: "text-emerald-700",
    },
    in_progress: {
      card: "bg-amber-50 border-amber-300 hover:border-amber-500 hover:shadow-sm",
      pill: "bg-amber-500",
      pillText: "In progress",
      icon: "text-amber-700",
    },
    blocked: {
      card: "bg-red-50 border-red-300 hover:border-red-500 hover:shadow-sm",
      pill: "bg-red-600",
      pillText: "Blocked",
      icon: "text-red-700",
    },
    not_started: {
      card: "bg-gray-50 border-gray-200 hover:border-gray-300",
      pill: "bg-gray-400",
      pillText: "Not started",
      icon: "text-ink-slate",
    },
  };
  const s = styles[stage.status];

  const inner = (
    <div
      className={`flex-1 min-w-0 border rounded-xl p-3 transition-all ${s.card}`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className={`text-[10px] font-bold uppercase tracking-wide ${s.icon}`}>
          {String(index + 1).padStart(2, "0")} · {stage.label}
        </div>
        <span
          className={`text-[9px] font-bold uppercase text-white px-1.5 py-0.5 rounded ${s.pill}`}
        >
          {s.pillText}
        </span>
      </div>
      <div className="text-xs text-navy/90 leading-snug line-clamp-2">
        {stage.detail}
      </div>
    </div>
  );

  // Cards are interactive when there's a meaningful destination; falls
  // back to a plain div for "stay here" or unclickable stages.
  return stage.href ? (
    <Link href={stage.href} className="flex-1 min-w-0 flex">
      {inner}
    </Link>
  ) : (
    inner
  );
}

// ─── PRODUCTION STATUS CARD ────────────────────────────────────────────

/**
 * Promote-to-production lever on the client profile.
 *
 * States:
 *   - Not enabled  → green "Move to production" CTA + 1-line explainer
 *   - Enabled+live → teal "In production since X" badge with Pause + Disable
 *   - Enabled+paused → amber banner with paused reason + Unpause + Disable
 *
 * Calls POST /api/clients/[id]/production with action: enable | pause |
 * unpause | disable. Page refresh on success so the next render pulls
 * the new state from the server (single source of truth).
 */
function ProductionStatusCard({
  clientLinkId,
  clientName,
  dailyReconEnabled,
  dailyReconPaused,
  pausedReason,
  enabledAt,
  cleanupCompletedAt,
  reachedBsStage,
}: {
  clientLinkId: string;
  clientName: string;
  dailyReconEnabled: boolean;
  dailyReconPaused: boolean;
  pausedReason: string | null;
  enabledAt: string | null;
  cleanupCompletedAt: string | null;
  /** True once COA cleanup + reclass + bank rules are all done — i.e. the
   *  client has progressed to the balance-sheet stage. The "Ready for
   *  production?" CTA only appears at this point; before it, promoting is
   *  premature so we hide the card entirely. */
  reachedBsStage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: "enable" | "pause" | "unpause" | "disable", reason?: string) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/production`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to update production state.");
        return;
      }
      router.refresh();
    } catch (e: any) {
      setError(e?.message || "Network error");
    } finally {
      setBusy(null);
    }
  }

  // Not enrolled — show the "Move to production" CTA. Soft-gate on
  // cleanup_completed_at: surface a warning if cleanup hasn't been
  // marked complete, but still allow override (some clients come in
  // already clean and don't need a cleanup run).
  if (!dailyReconEnabled) {
    // Always surface the promote CTA for un-enrolled clients. We used to hide
    // it until the COA/reclass/rules stages all read "complete" — but the
    // stage derivation is easily thrown off by a stale failed or in-review job
    // (and some clients come in already clean), which left seniors with NO way
    // to move a verified-clean client to production. Show it always; warn
    // (below) when the stages aren't all green, but allow the override.
    return (
      <section className="rounded-2xl border-2 border-teal/20 bg-gradient-to-br from-teal/5 to-white p-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-teal/10 flex-shrink-0">
            <Zap size={20} className="text-teal" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-navy">Ready for production?</h3>
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-200 text-gray-700">
                Not enrolled
              </span>
            </div>
            <p className="text-sm text-ink-slate mt-1 leading-relaxed">
              Moving <strong>{clientName}</strong> to production turns on the daily
              3am reconciliation cron. New transactions get auto-categorized at ≥95%
              confidence; anything below or unmatched lands on the Today queue for
              your sr. to review.
            </p>
            {!reachedBsStage && (
              <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <strong>Heads up:</strong> COA cleanup, reclass, and bank rules
                aren&apos;t all marked complete in the system yet. If you&apos;ve
                finished (or are intentionally skipping) cleanup, you can still move
                this client to production — this overrides the stage checks.
              </div>
            )}
            {reachedBsStage && !cleanupCompletedAt && (
              <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <strong>Heads up:</strong> cleanup hasn&apos;t been marked complete for
                this client yet. You can still promote, but ideally finish a cleanup
                pass first so the AI has clean baseline data to learn from.
              </div>
            )}
            {error && (
              <div className="mt-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
          </div>
          <button
            onClick={() => call("enable")}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg disabled:opacity-50 flex-shrink-0"
          >
            {busy === "enable" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Zap size={14} />
            )}
            Move to production
          </button>
        </div>
      </section>
    );
  }

  // Enrolled + paused — amber banner with unpause / disable actions
  if (dailyReconPaused) {
    return (
      <section className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-amber-100 flex-shrink-0">
            <PauseIcon size={20} className="text-amber-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-amber-900">Daily recon paused</h3>
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-200 text-amber-900">
                In production · paused
              </span>
            </div>
            <p className="text-sm text-amber-900 mt-1 leading-relaxed">
              <strong>Reason:</strong> {pausedReason || "(no reason given)"}
            </p>
            <p className="text-xs text-amber-800 mt-1">
              The 3am cron will skip this client until you unpause. Already-queued
              items on /today are still actionable.
            </p>
            {error && (
              <div className="mt-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2 flex-shrink-0">
            <button
              onClick={() => call("unpause")}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50"
            >
              {busy === "unpause" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <PlayIcon size={12} />
              )}
              Unpause
            </button>
            <button
              onClick={() => {
                if (!confirm("Disable daily recon entirely for this client? They'll need to be re-enrolled to resume.")) return;
                call("disable");
              }}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 border border-amber-300 hover:bg-amber-100 text-amber-900 text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50"
            >
              {busy === "disable" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <PowerOff size={12} />
              )}
              Disable
            </button>
          </div>
        </div>
      </section>
    );
  }

  // Enrolled + live — teal success state
  const enabledLabel = enabledAt
    ? new Date(enabledAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "(date unknown)";

  return (
    <section className="rounded-2xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-emerald-100 flex-shrink-0">
          <CheckCircle2 size={20} className="text-emerald-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-emerald-900">In production</h3>
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-600 text-white">
              Daily recon active
            </span>
          </div>
          <p className="text-sm text-emerald-900 mt-1 leading-relaxed">
            New transactions pulled every morning at 3am ET. Auto-categorized at
            ≥95% confidence; the rest goes to /today for your sr.&apos;s eyes.
          </p>
          <p className="text-xs text-emerald-700 mt-1">
            Enrolled since <strong>{enabledLabel}</strong>
          </p>
          {error && (
            <div className="mt-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 flex-shrink-0">
          <Link
            href={`/today/${clientLinkId}`}
            className="inline-flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold px-3 py-2 rounded-lg"
          >
            Open queue <ArrowRight size={12} />
          </Link>
          <button
            onClick={() => {
              const reason = window.prompt("Reason for pausing daily recon? (Shown to other bookkeepers)");
              if (reason === null) return;
              call("pause", reason || undefined);
            }}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 border border-emerald-300 hover:bg-emerald-100 text-emerald-900 text-xs font-bold px-3 py-2 rounded-lg disabled:opacity-50"
          >
            {busy === "pause" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <PauseIcon size={12} />
            )}
            Pause
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── PROFILE TAB ───────────────────────────────────────────────────────
// The editable client contact/details card + the read-only onboarding
// answers table. Lives in its own tab so Overview stays focused on status.

function ProfileTab({
  clientLink,
  onboarding,
}: {
  clientLink: ClientLink;
  onboarding?: OnboardingProfile | null;
}) {
  return (
    <div className="space-y-6">
      <ClientDetailsCard
        clientLinkId={clientLink.id}
        initial={{
          contact_first_name: clientLink.contact_first_name ?? null,
          contact_last_name: clientLink.contact_last_name ?? null,
          client_email: clientLink.client_email ?? null,
          client_phone: clientLink.client_phone ?? null,
          legal_business_name: clientLink.legal_business_name ?? null,
          trade_type: clientLink.trade_type ?? null,
          corporate_type: clientLink.corporate_type ?? null,
          fiscal_year_end: clientLink.fiscal_year_end ?? null,
          country: clientLink.country ?? null,
          state_province: clientLink.state_province ?? null,
          address_line1: clientLink.address_line1 ?? null,
          address_line2: clientLink.address_line2 ?? null,
          city: clientLink.city ?? null,
          postal_code: clientLink.postal_code ?? null,
          annual_revenue_range: clientLink.annual_revenue_range ?? null,
          taxes_up_to_date: clientLink.taxes_up_to_date ?? null,
          prior_bookkeeper: clientLink.prior_bookkeeper ?? null,
          accounting_software: clientLink.accounting_software ?? null,
          payroll_provider: clientLink.payroll_provider ?? null,
          employee_count_range: clientLink.employee_count_range ?? null,
          uses_business_cards: clientLink.uses_business_cards ?? null,
          keeps_receipts: clientLink.keeps_receipts ?? null,
          bank_connected_to_software: clientLink.bank_connected_to_software ?? null,
          profile_updated_at: clientLink.profile_updated_at ?? null,
        }}
        onboardingAnswers={onboarding?.answers}
      />
      {onboarding && <OnboardingDetailsCard onboarding={onboarding} />}

      {/* Grain call recordings — Ironbooks-hosted calls matched to this
          client by email/name, with AI summary + client/BK action items. */}
      <GrainSection clientLinkId={clientLink.id} />
    </div>
  );
}

// ─── OVERVIEW TAB ──────────────────────────────────────────────────────

function OverviewTab({
  clientLink,
  overview,
  qboStatus,
  onboarding,
  bsCleanupOwed,
  canSendMessages,
}: {
  clientLink: ClientLink;
  overview: OverviewBundle;
  qboStatus: "connected" | "token_expired" | "never_connected";
  onboarding?: OnboardingProfile | null;
  bsCleanupOwed?: boolean;
  canSendMessages?: boolean;
}) {
  const { outstanding, summary, activity, progress } = overview;

  // "Reached the BS stage" = COA cleanup, reclass, and bank rules are all
  // complete. The Move-to-production CTA only appears at this point.
  const stageDone = (key: string) =>
    progress?.stages?.find((s) => s.key === key)?.status === "complete";
  const reachedBsStage =
    !!clientLink.daily_recon_enabled ||
    (stageDone("coa") && stageDone("reclass") && stageDone("rules"));

  return (
    <div className="space-y-6">
      {/* QBO connection status — always visible, above everything else.
          Green when healthy; amber + big Reconnect button + instructions
          when the token expired or was never set up. Without this the
          bookkeeper has to figure out why financial tabs are empty from
          the "couldn't fetch P&L" amber banner elsewhere. */}
      <QboConnectionBanner
        clientLinkId={clientLink.id}
        clientName={clientLink.client_name}
        qboRealmId={clientLink.qbo_realm_id}
        status={qboStatus}
      />

      {/* Balance-sheet cleanup deferred — still owed. Surfaced here so a
          client live in production doesn't silently skip its BS cleanup. */}
      {bsCleanupOwed && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertTriangle size={15} className="flex-shrink-0" />
          <span><strong>Balance-sheet cleanup deferred</strong> — this client still owes a BS cleanup. Mark it done from the Clients manager dashboard once complete.</span>
        </div>
      )}

      {/* Inline message thread — "text" the client without leaving the profile. */}
      <MessagesPanel clientLinkId={clientLink.id} canSend={canSendMessages !== false} />

      {/* Open action items pulled from every Grain call — check them off
          here; they cross off in the call card on the Profile tab. */}
      <CallTodosPanel clientLinkId={clientLink.id} />

      {/* Production status — the lever that takes a client from "we
          cleaned them up once" to "the 3am cron pulls their books
          every morning." Auto-hides for clients with no QBO connection
          since promotion is pointless without working tokens. */}
      {qboStatus === "connected" && (
        <ProductionStatusCard
          clientLinkId={clientLink.id}
          clientName={clientLink.client_name}
          dailyReconEnabled={!!clientLink.daily_recon_enabled}
          dailyReconPaused={!!clientLink.daily_recon_paused}
          pausedReason={clientLink.daily_recon_paused_reason || null}
          enabledAt={clientLink.daily_recon_enabled_at || null}
          cleanupCompletedAt={clientLink.cleanup_completed_at || null}
          reachedBsStage={reachedBsStage}
        />
      )}

      {/* Closing the month lives on the production board — ONE close path,
          with the checks, attestation, and Books Reliability gates. The old
          per-profile CloseAndSendCard bypassed all three. */}
      {qboStatus === "connected" && clientLink.daily_recon_enabled && (
        <section className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-navy">Monthly close</h3>
            <p className="text-xs text-ink-slate mt-0.5">
              Close the month and send statements from the Production board — checks,
              attestation, and verification happen there.
            </p>
          </div>
          <Link
            href="/production"
            className="text-xs font-bold text-teal border border-teal/30 hover:bg-teal/5 rounded-lg px-3 py-2 flex-shrink-0"
          >
            Open Production board →
          </Link>
        </section>
      )}

      {/* Statements — bookkeeper-uploaded (and client-uploaded) bank/CC/loan
          statements, AI-identified + matched to QBO + filed by month. */}
      <StatementsCard clientLinkId={clientLink.id} />

      {/* Progress flow chart — bird's-eye view of where this client is in
          their SNAP lifecycle. Renders above Outstanding Work so the
          bookkeeper sees the "where are we" answer before the "what's
          broken" list. */}
      {progress && <ProgressFlowChart progress={progress} />}

      {/* Client details + onboarding answers moved to their own "Profile"
          tab to keep Overview focused on status + outstanding work. */}

      {/* Outstanding work — top-priority card. If empty we show a positive
          "all clear" state because seeing "0 outstanding items" hidden in
          a corner feels less reassuring than a deliberate empty state. */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-navy">Outstanding work</h2>
          {outstanding && outstanding.totalCount > 0 && (
            <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
              {outstanding.totalCount} item{outstanding.totalCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {outstanding && outstanding.items.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {outstanding.items.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="group flex items-start gap-3 bg-white border border-gray-200 hover:border-amber-300 hover:shadow-sm rounded-xl p-4 transition-all"
              >
                <div className="shrink-0 mt-0.5">
                  <AlertCircle
                    size={18}
                    className={
                      item.category.includes("failed")
                        ? "text-red-500"
                        : "text-amber-500"
                    }
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-navy group-hover:text-teal">
                    {item.label}
                  </div>
                  <div className="text-xs text-ink-slate mt-0.5 truncate">
                    {item.detail}
                  </div>
                  {item.occurredAt && (
                    <div className="text-[10px] text-ink-slate/70 mt-1">
                      {new Date(item.occurredAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <ChevronRight
                  size={16}
                  className="shrink-0 text-ink-slate group-hover:text-teal mt-0.5"
                />
              </Link>
            ))}
          </div>
        ) : (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-800">
            ✓ Nothing outstanding — this client is up to date.
          </div>
        )}
      </section>

      {/* SNAP-side summary stats — bank rules + recent jobs. Quick numeric
          glance that complements the outstanding-work cards above. */}
      {summary && (
        <section>
          <h2 className="text-base font-bold text-navy mb-3">SNAP status</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatCard
              label="Active bank rules"
              value={summary.activeBankRules}
              subtext={
                summary.lastRuleExportAt
                  ? `Last exported ${new Date(summary.lastRuleExportAt).toLocaleDateString()}`
                  : "Never exported to QBO"
              }
            />
            <StatCard
              label="Recent reclass jobs"
              value={summary.recentReclassJobs.length}
              subtext={
                summary.recentReclassJobs[0]
                  ? `Latest: ${summary.recentReclassJobs[0].status}`
                  : "No reclass jobs yet"
              }
            />
            <StatCard
              label="Recent BS cleanups"
              value={summary.recentCleanups.length}
              subtext={
                summary.recentCleanups[0]
                  ? `Latest: ${summary.recentCleanups[0].status}`
                  : "No cleanups yet"
              }
            />
          </div>
          {summary.recentReclassJobs.length > 0 && (
            <div className="mt-4 bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
              {summary.recentReclassJobs.map((j) => (
                <Link
                  key={j.id}
                  href={`/reclass/${j.id}/review`}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-teal-lighter/50 transition-colors"
                >
                  <div className="text-sm">
                    <span className="font-semibold text-navy">
                      {j.workflow || "reclass"}
                    </span>
                    <span className="text-ink-slate mx-2">·</span>
                    <span className="text-ink-slate">
                      {j.sourceAccountName || "all accounts"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={j.status} />
                    <span className="text-xs text-ink-slate">
                      {new Date(j.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Recent activity strip — last 10 events from audit_log */}
      {activity.length > 0 && (
        <section>
          <h2 className="text-base font-bold text-navy mb-3">Recent activity</h2>
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {activity.slice(0, 10).map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between px-4 py-2.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Activity size={13} className="text-ink-slate shrink-0" />
                  <span className="text-sm text-navy truncate">{e.label}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-ink-slate">
                    {new Date(e.occurredAt).toLocaleString()}
                  </span>
                  {e.href && (
                    <Link
                      href={e.href}
                      className="text-xs font-semibold text-teal hover:text-teal-dark"
                    >
                      View →
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── ACTIVITY TAB ──────────────────────────────────────────────────────

function ActivityTab({ activity }: { activity: ActivityEvent[] }) {
  if (activity.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-ink-slate">
        No recent SNAP activity logged for this client.
      </div>
    );
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
      {activity.map((e) => (
        <div
          key={e.id}
          className="flex items-start justify-between px-5 py-3 hover:bg-teal-lighter/30"
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold text-navy">{e.label}</div>
            <div className="text-[11px] text-ink-slate mt-0.5 font-mono">
              {e.eventType}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <span className="text-xs text-ink-slate">
              {new Date(e.occurredAt).toLocaleString()}
            </span>
            {e.href && (
              <Link
                href={e.href}
                className="text-xs font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
              >
                View <ExternalLink size={11} />
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── QBO CONNECTION BANNER ─────────────────────────────────────────────

/**
 * Big status card at the top of the Overview tab. Three states:
 *
 *   • connected      → green, ✓, shows realm id + "View in QuickBooks" link
 *   • token_expired  → red, ⚠, big "Reconnect QuickBooks" CTA + instructions
 *                       (most common cause of "P&L looks empty" support
 *                        tickets — refresh tokens die after 100 days of
 *                        disuse or when the client revokes from QBO admin)
 *   • never_connected → amber, ⚡, big "Connect QuickBooks" CTA + instructions
 *
 * The CTA always points at /api/qbo/connect?client_link_id=<id> — the
 * existing OAuth-initiate route. It launches the Intuit consent screen
 * and round-trips the bookkeeper back here on success.
 */
function QboConnectionBanner({
  clientLinkId,
  clientName,
  qboRealmId,
  status,
}: {
  clientLinkId: string;
  clientName: string;
  qboRealmId: string | null;
  status: "connected" | "token_expired" | "never_connected";
}) {
  if (status === "connected") {
    return (
      <div className="rounded-2xl border-2 border-green-200 bg-green-50/60 p-5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 size={26} className="text-green-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-bold text-navy">
            QuickBooks connected
          </div>
          <div className="text-xs text-ink-slate mt-0.5">
            All financial data on this page is fetched live from QBO each load.
            {qboRealmId && (
              <span className="ml-1 font-mono text-ink-light">· realm {qboRealmId}</span>
            )}
          </div>
        </div>
        {qboRealmId && (
          <a
            href={`https://app.qbo.intuit.com/app/homepage?cid=${qboRealmId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-700 hover:text-green-900 border border-green-300 hover:border-green-500 bg-white rounded-lg px-3 py-2 flex-shrink-0"
          >
            <ExternalLink size={12} /> Open in QuickBooks
          </a>
        )}
      </div>
    );
  }

  const isExpired = status === "token_expired";
  const palette = isExpired
    ? {
        border: "border-red-300",
        bg: "bg-red-50",
        iconBg: "bg-red-100",
        iconColor: "text-red-700",
        titleColor: "text-red-900",
        body: "text-red-900",
        buttonBg: "bg-red-600 hover:bg-red-700",
        buttonText: "Reconnect QuickBooks",
      }
    : {
        border: "border-amber-300",
        bg: "bg-amber-50",
        iconBg: "bg-amber-100",
        iconColor: "text-amber-700",
        titleColor: "text-amber-900",
        body: "text-amber-900",
        buttonBg: "bg-teal hover:bg-teal-dark",
        buttonText: "Connect QuickBooks",
      };
  const Icon = isExpired ? XCircle : Plug;

  return (
    <div className={`rounded-2xl border-2 ${palette.border} ${palette.bg} p-5`}>
      <div className="flex items-start gap-4">
        <div className={`w-12 h-12 rounded-full ${palette.iconBg} flex items-center justify-center flex-shrink-0`}>
          <Icon size={26} className={palette.iconColor} />
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-base font-bold ${palette.titleColor}`}>
            {isExpired
              ? `QuickBooks connection expired for ${clientName}`
              : `QuickBooks not connected for ${clientName}`}
          </div>
          <div className={`text-xs ${palette.body} mt-1 leading-relaxed`}>
            {isExpired ? (
              <>
                SNAP can&apos;t refresh the QBO access token — this usually means the
                refresh token aged out (Intuit kills them after ~100 days of
                disuse) or the client revoked SNAP&apos;s app from inside QBO. P&amp;L,
                Balance Sheet, and Bank Balances will be empty until you
                re-authorize.
              </>
            ) : (
              <>
                Financial tabs (P&amp;L, Balance Sheet, Banks) and any
                cleanup workflow that touches QBO need an active connection.
                Click below to sign in to Intuit and grant SNAP read/write
                access to this client&apos;s books.
              </>
            )}
          </div>

          {/* How-to instructions */}
          <ol className={`text-[11px] ${palette.body} mt-3 ml-4 list-decimal space-y-0.5 leading-snug`}>
            <li>Click <strong>{palette.buttonText}</strong> below.</li>
            <li>
              On Intuit&apos;s sign-in page, sign in with the bookkeeper&apos;s QBO
              account that has access to <strong>{clientName}</strong>.
            </li>
            <li>
              On the &quot;Choose a company&quot; screen, pick the right QuickBooks
              company file for this client.
            </li>
            <li>Click <strong>Connect</strong> on the permissions screen.</li>
            <li>
              You&apos;ll land back on this page — refresh once if the banner
              doesn&apos;t flip to green within a few seconds.
            </li>
          </ol>

          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <a
              href={`/api/qbo/connect?client_link_id=${clientLinkId}`}
              className={`inline-flex items-center gap-2 ${palette.buttonBg} text-white text-sm font-bold rounded-lg px-5 py-2.5 shadow-sm transition-colors`}
            >
              {palette.buttonText} <ArrowRight size={15} />
            </a>
            <Link
              href={`/clients/${clientLinkId}/match-double`}
              className={`text-xs font-semibold ${palette.body} hover:underline`}
            >
              Open client settings
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── FINANCIAL TABS ────────────────────────────────────────────────────

function NoQboState({ clientLinkId }: { clientLinkId: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
      <div className="text-sm font-semibold text-navy mb-1">
        QuickBooks not connected
      </div>
      <div className="text-xs text-ink-slate mb-3">
        Financial reports need a live QBO connection for this client.
      </div>
      <Link
        href={`/clients/${clientLinkId}/match-double`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark"
      >
        Configure client settings →
      </Link>
    </div>
  );
}

function RangePicker({
  clientLinkId,
  activeKey,
  rangeStart,
  rangeEnd,
}: {
  clientLinkId: string;
  activeKey: string;
  rangeStart: string;
  rangeEnd: string;
}) {
  const router = useRouter();
  const [customOpen, setCustomOpen] = useState(activeKey === "custom");
  const [start, setStart] = useState(rangeStart);
  const [end, setEnd] = useState(rangeEnd);
  const customActive = activeKey === "custom";
  const valid = start && end && start <= end;

  // URL-driven picker — presets navigate to ?range=<key>; Custom reveals
  // two date inputs that navigate to ?range=custom&start&end. Bookmarkable
  // and refresh-safe; the server re-fetches the right window.
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 flex-wrap">
        {RANGE_PRESETS.map((p) => {
          const active = p.key === activeKey;
          return (
            <Link
              key={p.key}
              href={`/clients/${clientLinkId}?range=${p.key}`}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-md transition-colors ${
                active
                  ? "bg-navy text-white"
                  : "text-ink-slate hover:text-navy bg-white border border-gray-200 hover:border-gray-300"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
        <button
          onClick={() => setCustomOpen((o) => !o)}
          className={`text-[11px] font-semibold px-2.5 py-1 rounded-md transition-colors ${
            customActive
              ? "bg-navy text-white"
              : "text-ink-slate hover:text-navy bg-white border border-gray-200 hover:border-gray-300"
          }`}
        >
          Custom
        </button>
      </div>
      {customOpen && (
        <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-200 rounded-lg px-3 py-2 w-fit">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="text-xs border border-gray-200 rounded px-2 py-1"
          />
          <span className="text-xs text-ink-light">→</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="text-xs border border-gray-200 rounded px-2 py-1"
          />
          <button
            onClick={() => valid && router.push(`/clients/${clientLinkId}?range=custom&start=${start}&end=${end}`)}
            disabled={!valid}
            className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-teal text-white hover:bg-teal-dark disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

function PLTab({
  financials,
  clientLinkId,
  onDrill,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  // Local UI toggle — by default we hide zero-balance accounts so the page
  // isn't a wall of "$0" rows. Bookkeepers verifying COA completeness flip
  // the toggle on; everyone else gets a clean activity-only view.
  const [showZeros, setShowZeros] = useState(false);
  const [byMonth, setByMonth] = useState(false);

  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.overview) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch P&amp;L from QuickBooks. The QBO connection might have expired —
        check the client settings and try again.
      </div>
    );
  }

  const pl = financials.overview.primaryPL;
  const prev = financials.overview.comparisonPL;
  const incomeDelta = pl.totalIncome - prev.totalIncome;
  const expensesDelta = pl.totalExpenses - prev.totalExpenses;
  const niDelta = pl.netIncome - prev.netIncome;

  // ─── Full-COA merge ─────────────────────────────────────────────────
  // Build a row for every active P&L account from QBO (Revenue / Expense
  // classifications). Then merge in the P&L report's line-item amounts so
  // accounts with zero activity show as $0 instead of being invisible.
  // This is the "show full COA so we can verify completeness" half of
  // Mike's request.
  //
  // financials.balanceSheet.accounts returns ALL active accounts (quirk
  // of the underlying fetchAllAccounts call), so it's the right source
  // for both BS and P&L COA views.
  const allAccounts = financials.balanceSheet?.accounts || [];
  type PLRow = {
    accountId: string | null;
    name: string;
    accountType: string;
    classification: "Revenue" | "Expense";
    amount: number;
  };
  const rowsByAcctId = new Map<string, PLRow>();
  const rowsByName = new Map<string, PLRow>();
  for (const acct of allAccounts) {
    const cls = acct.Classification;
    if (cls !== "Revenue" && cls !== "Expense") continue;
    const row: PLRow = {
      accountId: acct.Id,
      name: acct.FullyQualifiedName || acct.Name,
      accountType: acct.AccountType,
      classification: cls as "Revenue" | "Expense",
      amount: 0,
    };
    rowsByAcctId.set(acct.Id, row);
    rowsByName.set(row.name.toLowerCase(), row);
  }
  // Merge in PL line items — match by account_id first, then label.
  // Lines that don't match (rare: deleted accounts, JE-only lines) get
  // added so the bookkeeper still sees them.
  for (const line of pl.lineItems) {
    let row: PLRow | undefined;
    if (line.account_id) row = rowsByAcctId.get(line.account_id);
    if (!row) row = rowsByName.get((line.label || "").toLowerCase());
    if (row) {
      row.amount = line.amount;
    } else {
      const cls: "Revenue" | "Expense" = /income|revenue/i.test(line.group)
        ? "Revenue"
        : "Expense";
      rowsByName.set((line.label || "").toLowerCase() + `_${Math.random()}`, {
        accountId: line.account_id,
        name: line.label || "Unknown account",
        accountType: line.group || cls,
        classification: cls,
        amount: line.amount,
      });
    }
  }

  const allRows = [...rowsByName.values()];
  const filtered = showZeros
    ? allRows
    : allRows.filter((r) => Math.abs(r.amount) >= 0.005);

  const incomeRows = filtered
    .filter((r) => r.classification === "Revenue")
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const cogsRows = filtered
    .filter(
      (r) => r.classification === "Expense" && /cost of goods sold/i.test(r.accountType)
    )
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const expenseRows = filtered
    .filter(
      (r) => r.classification === "Expense" && !/cost of goods sold/i.test(r.accountType)
    )
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const totalAccounts = allRows.length;
  const populatedAccounts = allRows.filter((r) => Math.abs(r.amount) >= 0.005).length;

  // Detection: deleted/inactive accounts that still carry a balance. QBO appends
  // "(deleted)" to an inactive account's name; if transactions landed in it
  // (usually a memorized/recurring txn in QBO posting to an old account) it
  // lingers on the P&L. Surface them so a bookkeeper merges/renames instead of
  // leaving the mess. Detected by the "(deleted)" name suffix with activity.
  const deletedWithBalance = allRows.filter(
    (r) => /\(deleted\)/i.test(r.name) && Math.abs(r.amount) >= 0.005
  );

  return (
    <div className="space-y-4">
      {deletedWithBalance.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-amber-900">
                {deletedWithBalance.length} deleted account{deletedWithBalance.length === 1 ? "" : "s"} still {deletedWithBalance.length === 1 ? "has" : "have"} a balance
              </div>
              <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">
                These accounts were deleted in QuickBooks but transactions have posted to them since — so they show as &quot;(deleted)&quot; on the P&amp;L. Reclass their transactions into an active account (merge), then find the recurring/memorized transaction in QBO that&apos;s feeding them.
              </p>
              <ul className="mt-2 space-y-1">
                {deletedWithBalance.map((r, i) => (
                  <li key={`${r.accountId || r.name}-${i}`} className="flex items-center justify-between text-xs">
                    <span className="text-amber-900 font-medium truncate pr-2">{r.name}</span>
                    <span className="font-mono font-semibold text-amber-900 flex-shrink-0">{formatCurrency(r.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <RangePicker
          clientLinkId={clientLinkId}
          activeKey={financials.activeRangeKey}
          rangeStart={financials.rangeStart}
          rangeEnd={financials.rangeEnd}
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-ink-slate">
            Range:{" "}
            <span className="font-semibold text-navy">
              {financials.primaryRangeLabel}
            </span>
            {" "}vs prior period {financials.comparisonRangeLabel}
            <span className="ml-3 text-ink-slate/70">
              · {populatedAccounts} of {totalAccounts} P&amp;L accounts have activity
            </span>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-ink-slate cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showZeros}
              onChange={(e) => setShowZeros(e.target.checked)}
              className="rounded border-gray-300 text-teal focus:ring-teal"
            />
            Show zero-balance accounts
          </label>
        </div>
      </div>
      <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs font-semibold">
        <button
          onClick={() => setByMonth(false)}
          className={`px-3 py-1.5 ${!byMonth ? "bg-teal text-white" : "bg-white text-ink-slate hover:bg-gray-50"}`}
        >
          Single period
        </button>
        <button
          onClick={() => setByMonth(true)}
          className={`px-3 py-1.5 border-l border-gray-200 ${byMonth ? "bg-teal text-white" : "bg-white text-ink-slate hover:bg-gray-50"}`}
        >
          By month (last 3)
        </button>
      </div>

      {byMonth ? (
        <PLByMonthView clientLinkId={clientLinkId} />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <KPICard label="Total income" value={pl.totalIncome} delta={incomeDelta} />
            <KPICard label="Total expenses" value={pl.totalExpenses} delta={expensesDelta} invertDeltaColor />
            <KPICard label="Net income" value={pl.netIncome} delta={niDelta} />
          </div>
          <PLSection title="Income" rows={incomeRows} total={pl.totalIncome} onDrill={onDrill} />
          {cogsRows.length > 0 && (
            <PLSection
              title="Cost of Goods Sold"
              rows={cogsRows}
              total={cogsRows.reduce((s, r) => s + r.amount, 0)}
              onDrill={onDrill}
            />
          )}
          <PLSection title="Expenses" rows={expenseRows} total={pl.totalExpenses} onDrill={onDrill} />
        </>
      )}
    </div>
  );
}

function PLSection({
  title,
  rows,
  total,
  onDrill,
}: {
  title: string;
  rows: Array<{ accountId: string | null; name: string; accountType: string; amount: number }>;
  total: number;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50">
        <div className="text-xs font-bold uppercase text-ink-slate tracking-wide">
          {title} · {rows.length} {rows.length === 1 ? "account" : "accounts"}
        </div>
        <div className="font-mono text-sm font-bold text-navy">
          {formatCurrency(total)}
        </div>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-ink-slate text-center">
            No {title.toLowerCase()} accounts to show.
          </div>
        ) : (
          rows.map((r, i) => {
            const isZero = Math.abs(r.amount) < 0.005;
            const clickable = !!r.accountId;
            return (
              <button
                key={`${r.accountId || r.name}-${i}`}
                onClick={() => r.accountId && onDrill(r.accountId, r.name)}
                disabled={!clickable}
                className={`w-full flex items-center justify-between px-4 py-2 text-sm text-left ${
                  clickable
                    ? "hover:bg-teal-lighter/40 cursor-pointer"
                    : "cursor-default"
                } ${isZero ? "opacity-60" : ""}`}
                title={clickable ? "Click to see transactions" : "No account ID — can't drill"}
              >
                <div className="text-navy truncate pr-2 flex-1 min-w-0">
                  {r.name}
                  <span className="text-[10px] text-ink-slate ml-2 font-normal">
                    {r.accountType}
                  </span>
                </div>
                <div
                  className={`font-mono font-semibold shrink-0 ${
                    r.amount < 0 ? "text-red-600" : isZero ? "text-ink-slate" : "text-navy"
                  }`}
                >
                  {formatCurrency(r.amount)}
                </div>
                {clickable && (
                  <ChevronRight size={14} className="text-ink-slate ml-1 shrink-0" />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function BSTab({
  financials,
  clientLinkId,
  onDrill,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.balanceSheet) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch the Balance Sheet from QuickBooks.
      </div>
    );
  }

  const bs = financials.balanceSheet;
  // Group by Classification + sort by absolute balance. Internal users
  // see ALL active accounts, not just top-5 like the portal — they need
  // the full picture for cleanup decisions. We carry the accountId on
  // each row so the drill-down can fire when clicked.
  type BSRow = { accountId: string; name: string; balance: number };
  const groups: Record<"Asset" | "Liability" | "Equity", BSRow[]> = {
    Asset: [],
    Liability: [],
    Equity: [],
  };
  for (const acct of bs.accounts) {
    const bal = bs.balances.get(acct.Id) ?? 0;
    if (Math.abs(bal) < 0.01) continue;
    const g = acct.Classification as keyof typeof groups;
    if (g in groups) {
      groups[g].push({
        accountId: acct.Id,
        name: acct.FullyQualifiedName || acct.Name,
        balance: bal,
      });
    }
  }
  for (const k of Object.keys(groups) as Array<keyof typeof groups>) {
    groups[k].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-ink-slate">
        <div>
          As of <span className="font-semibold text-navy">{bs.asOfDate}</span>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href={`/clients/${clientLinkId}/cpa`}
            className="font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
            title="Diff the CPA's closing TB against QBO, enter their AJEs, tie out filed tax amounts"
          >
            CPA round-trip <ExternalLink size={11} />
          </Link>
          <Link
            href={`/balance-sheet/${clientLinkId}`}
            className="font-semibold text-teal hover:text-teal-dark inline-flex items-center gap-1"
          >
            Open full BS workspace <ExternalLink size={11} />
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total assets" value={bs.totalAssets} />
        <KPICard label="Total liabilities" value={bs.totalLiabilities} />
        <KPICard label="Total equity" value={bs.totalEquity} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(["Asset", "Liability", "Equity"] as const).map((g) => (
          <BSGroup key={g} title={g} rows={groups[g]} onDrill={onDrill} />
        ))}
      </div>
    </div>
  );
}

function BSGroup({
  title,
  rows,
  onDrill,
}: {
  title: string;
  rows: Array<{ accountId: string; name: string; balance: number }>;
  onDrill: (accountId: string, accountName: string) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-ink-slate tracking-wide">
        {title}
      </div>
      <div className="divide-y divide-gray-100 max-h-96 overflow-auto">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-xs text-ink-slate text-center">No {title.toLowerCase()} balances</div>
        ) : (
          rows.map((r) => (
            <button
              key={r.accountId}
              onClick={() => onDrill(r.accountId, r.name)}
              className="w-full flex items-center justify-between px-4 py-2 text-sm text-left hover:bg-teal-lighter/40 transition-colors cursor-pointer"
              title="Click to see last 90 days of transactions hitting this account"
            >
              <div className="text-navy truncate pr-2 flex-1 min-w-0" title={r.name}>
                {r.name}
              </div>
              <div
                className={`font-mono font-semibold shrink-0 ${
                  r.balance < 0 ? "text-red-600" : "text-navy"
                }`}
              >
                {formatCurrency(r.balance)}
              </div>
              <ChevronRight size={14} className="text-ink-slate ml-1 shrink-0" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function BankTab({
  financials,
  clientLinkId,
}: {
  financials: FinancialsBundle;
  clientLinkId: string;
}) {
  if (!financials.hasQbo) return <NoQboState clientLinkId={clientLinkId} />;
  if (!financials.overview) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t fetch bank balances.
      </div>
    );
  }
  const banks = financials.overview.banks;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard label="Total cash" value={banks.totalCashOnHand} />
        <KPICard label="Credit card debt" value={banks.totalCreditCardDebt} invertDeltaColor />
        <KPICard
          label="Net liquidity"
          value={banks.totalCashOnHand - banks.totalCreditCardDebt}
        />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-ink-slate tracking-wide">
          Bank accounts &amp; credit cards
        </div>
        <div className="divide-y divide-gray-100">
          {banks.accounts.length === 0 ? (
            <div className="px-4 py-6 text-sm text-ink-slate text-center">
              No bank or credit card accounts found in QBO.
            </div>
          ) : (
            banks.accounts.map((a, i) => (
              <div
                key={`${a.name}-${i}`}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <div>
                  <div className="text-navy font-semibold">{a.name}</div>
                  <div className="text-[11px] text-ink-slate">{a.type}</div>
                </div>
                <div
                  className={`font-mono font-bold ${
                    a.balance < 0 ? "text-red-600" : "text-navy"
                  }`}
                >
                  {formatCurrency(a.balance)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── UI BITS ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subtext,
}: {
  label: string;
  value: number | string;
  subtext?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wide text-ink-slate font-semibold">
        {label}
      </div>
      <div className="text-2xl font-bold text-navy mt-1">{value}</div>
      {subtext && (
        <div className="text-[11px] text-ink-slate mt-1">{subtext}</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    complete: "bg-emerald-50 text-emerald-700",
    in_review: "bg-amber-50 text-amber-700",
    executing: "bg-blue-50 text-blue-700",
    failed: "bg-red-50 text-red-700",
    web_search_paused: "bg-purple-50 text-purple-700",
  };
  const className = styles[status] || "bg-gray-100 text-ink-slate";
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${className}`}>
      {status}
    </span>
  );
}

function KPICard({
  label,
  value,
  delta,
  invertDeltaColor,
}: {
  label: string;
  value: number;
  delta?: number;
  /** Treat "value went up" as bad (e.g. expenses, credit card debt). */
  invertDeltaColor?: boolean;
}) {
  const hasDelta = typeof delta === "number" && Math.abs(delta) > 0.005;
  const deltaIsBad = hasDelta
    ? invertDeltaColor
      ? delta! > 0
      : delta! < 0
    : false;
  const deltaIsGood = hasDelta && !deltaIsBad;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wide text-ink-slate font-semibold">
        {label}
      </div>
      <div
        className={`text-2xl font-bold mt-1 font-mono ${
          value < 0 ? "text-red-600" : "text-navy"
        }`}
      >
        {formatCurrency(value)}
      </div>
      {hasDelta && (
        <div
          className={`text-[11px] mt-1 font-semibold ${
            deltaIsGood ? "text-emerald-700" : deltaIsBad ? "text-red-600" : "text-ink-slate"
          }`}
        >
          {delta! > 0 ? "▲" : "▼"} {formatCurrency(Math.abs(delta!))} vs prior period
        </div>
      )}
    </div>
  );
}

function formatCurrency(n: number): string {
  // Compact format for the dashboard. Doesn't need to be exact-cent precision
  // — bookkeepers can drill into the underlying reports for that.
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ymdToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─── DRILL-DOWN DRAWER ─────────────────────────────────────────────────

interface DrillTransaction {
  id: string;
  type: string;
  date: string;
  doc_number: string | null;
  name: string | null;
  memo: string;
  amount: number;
  running_balance: number | null;
  cleared?: boolean;
}

function DrillDrawer({
  clientLinkId,
  accountId,
  accountName,
  kind,
  start,
  end,
  onClose,
}: {
  clientLinkId: string;
  accountId: string;
  accountName: string;
  kind: "pl" | "bs";
  start: string;
  end: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    transactions: DrillTransaction[];
    total: number;
    truncated: boolean;
  } | null>(null);
  // Bumped after a bulk reclass so the list refetches (moved txns leave this
  // account's view).
  const [reloadKey, setReloadKey] = useState(0);
  // Selection is keyed per transaction (`type::id`); split lines share a key so
  // selecting any row selects the whole transaction — which is what the bulk
  // move operates on.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/clients/${clientLinkId}/account-transactions?account_id=${encodeURIComponent(
      accountId
    )}&start=${start}&end=${end}&kind=${kind}`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `Fetch failed (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Failed to load transactions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientLinkId, accountId, start, end, kind, reloadKey]);

  const txnKey = (t: DrillTransaction) => `${t.type}::${t.id}`;
  // Distinct transactions (drill rows can repeat a txn for split lines).
  const distinctSelectable = Array.from(
    new Set((data?.transactions || []).map(txnKey))
  );
  const allSelected = distinctSelectable.length > 0 && selected.size === distinctSelectable.length;
  function toggleOne(t: DrillTransaction) {
    const k = txnKey(t);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) =>
      prev.size === distinctSelectable.length ? new Set() : new Set(distinctSelectable)
    );
  }

  // Sum + check vs the parent row's expected amount so the bookkeeper can
  // spot QBO report-vs-detail reconciliation discrepancies at a glance.
  const sumOfShown = (data?.transactions || []).reduce((s, t) => s + t.amount, 0);

  return (
    <>
      {/* Backdrop — click anywhere outside the drawer to close. Tab still
          available for screen readers via the close button below. */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer — slides from the right. Wide enough to read full memos
          without scrolling, fixed-position so it overlays the tab content
          without disturbing scroll on the page behind. */}
      <div className="fixed right-0 top-0 h-full w-full md:w-[700px] bg-white shadow-2xl z-50 flex flex-col">
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-ink-slate font-bold">
              {kind === "pl" ? "P&L transactions" : "Account activity"}
            </div>
            <div className="text-sm font-bold text-navy truncate" title={accountName}>
              {accountName}
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              {start} → {end}
              {data && (
                <span className="ml-2">
                  · {data.total} transaction{data.total === 1 ? "" : "s"}
                  {data.truncated && " (showing first 500)"}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 -mt-1 -mr-1 p-2 text-ink-slate hover:text-navy hover:bg-gray-100 rounded-lg"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="px-5 py-12 text-center text-sm text-ink-slate">
              <Loader2 className="animate-spin inline mr-2" size={14} />
              Loading transactions…
            </div>
          ) : error ? (
            <div className="m-5 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          ) : !data || data.transactions.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-ink-slate">
              No transactions in this range.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {/* Select-all — clicking any row checkbox opts that whole
                  transaction into the bulk-reclass action bar below. */}
              <label className="flex items-center gap-3 px-5 py-2 text-xs bg-gray-50 sticky top-0 z-10 cursor-pointer border-b border-gray-200">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="shrink-0 accent-teal"
                  aria-label="Select all transactions"
                />
                <span className="font-semibold text-ink-slate">
                  {selected.size > 0
                    ? `${selected.size} selected`
                    : `Select transactions to move`}
                </span>
              </label>
              {data.transactions.map((t, i) => (
                <label
                  key={`${t.id}-${i}`}
                  className="flex items-start gap-3 px-5 py-2.5 text-xs hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(txnKey(t))}
                    onChange={() => toggleOne(t)}
                    className="mt-0.5 shrink-0 accent-teal"
                    aria-label={`Select ${t.name || t.type} ${t.date}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-ink-slate shrink-0">{t.date}</span>
                        <span className="text-[10px] font-bold uppercase text-teal bg-teal-lighter/60 px-1.5 py-0.5 rounded shrink-0">
                          {t.type}
                        </span>
                        {t.doc_number && (
                          <span className="text-ink-slate shrink-0">#{t.doc_number}</span>
                        )}
                        {t.cleared && (
                          <span className="text-[10px] text-emerald-700 shrink-0">✓ cleared</span>
                        )}
                      </div>
                      <div
                        className={`font-mono font-bold shrink-0 ${
                          t.amount < 0 ? "text-red-600" : "text-navy"
                        }`}
                      >
                        {formatCurrencyExact(t.amount)}
                      </div>
                    </div>
                    <div className="text-navy">
                      {t.name && <span className="font-semibold">{t.name}</span>}
                      {t.name && t.memo && <span className="text-ink-slate"> · </span>}
                      {t.memo && <span className="text-ink-slate">{t.memo}</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {data && selected.size > 0 && (
          <BulkReclassBar
            clientLinkId={clientLinkId}
            sourceAccountId={accountId}
            sourceAccountName={accountName}
            selectedTxns={data.transactions
              .filter((t) => selected.has(txnKey(t)))
              .map((t) => ({ id: t.id, type: t.type }))}
            selectedCount={selected.size}
            onApplied={() => {
              setSelected(new Set());
              setReloadKey((k) => k + 1);
            }}
          />
        )}

        {data && data.transactions.length > 0 && (
          <div className="border-t border-gray-200 px-5 py-3 text-xs flex items-center justify-between bg-gray-50">
            <div className="text-ink-slate">
              Sum of shown:{" "}
              <span className="font-mono font-bold text-navy">
                {formatCurrencyExact(sumOfShown)}
              </span>
            </div>
            {data.truncated && (
              <div className="text-amber-700">
                Capped at 500 — sum may not equal the report total
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─── BULK RECLASS ──────────────────────────────────────────────────────
// Action bar inside the drill drawer: move the selected transactions out of
// the drilled account into a target account (P&L or BS), and optionally learn
// a per-client vendor rule so the same payees auto-categorize next time.
// Budget-chunked: re-invokes the API with `remaining` until the whole
// selection is processed.
type QboAccountOption = {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
  classification: string;
};

function BulkReclassBar({
  clientLinkId,
  sourceAccountId,
  sourceAccountName,
  selectedTxns,
  selectedCount,
  onApplied,
}: {
  clientLinkId: string;
  sourceAccountId: string;
  sourceAccountName: string;
  selectedTxns: Array<{ id: string; type: string }>;
  selectedCount: number;
  onApplied: () => void;
}) {
  const [accounts, setAccounts] = useState<QboAccountOption[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [target, setTarget] = useState<QboAccountOption | null>(null);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createRule, setCreateRule] = useState(true);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Lazy-load the account universe (P&L + BS) the first time the bar appears.
  useEffect(() => {
    if (accounts !== null) return;
    let cancelled = false;
    fetch(`/api/clients/${clientLinkId}/qbo-accounts`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `Fetch failed (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setAccounts(d.accounts || []);
      })
      .catch((e) => {
        if (!cancelled) setAccountsError(e?.message || "Could not load accounts");
      });
    return () => {
      cancelled = true;
    };
  }, [clientLinkId, accounts]);

  // Tokenized, punctuation-insensitive search (same matcher that fixed
  // "owner draw" not finding "Owner's Draw").
  const norm = (s: string) =>
    (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = norm(search).split(" ").filter(Boolean);
  const filtered = (accounts || [])
    .filter((a) => a.id !== sourceAccountId) // never offer the source
    .filter((a) => {
      if (tokens.length === 0) return true;
      const hay = norm(`${a.fullyQualifiedName} ${a.accountType} ${a.classification}`);
      return tokens.every((t) => hay.includes(t));
    })
    .slice(0, 60);
  const isPL = (a: QboAccountOption) =>
    ["Revenue", "Income", "Expense", "Other Income", "Other Expense", "Cost of Goods Sold"].some(
      (c) => a.classification === c || a.accountType.includes(c)
    );

  async function apply() {
    if (!target) return;
    setApplying(true);
    setApplyError(null);
    setResult(null);
    const totals: Record<string, number> = {
      moved_txns: 0,
      moved_lines: 0,
      skipped_unsupported: 0,
      skipped_closed: 0,
      skipped_stale: 0,
      skipped_no_source_line: 0,
      failed: 0,
      rules_created: 0,
      rules_updated: 0,
    };
    let queue = selectedTxns;
    const initial = queue.length;
    try {
      for (let pass = 0; pass < 25; pass++) {
        const res = await fetch(`/api/clients/${clientLinkId}/bulk-reclass`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_account_id: sourceAccountId,
            source_account_name: sourceAccountName,
            target_account_id: target.id,
            transactions: queue,
            create_rules: createRule,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        for (const k of Object.keys(totals)) totals[k] += d[k] || 0;
        if (!d.remaining?.length) break;
        queue = d.remaining;
        setProgress(`${initial - queue.length} of ${initial} processed…`);
      }
      setResult(totals);
      setProgress(null);
      onApplied();
    } catch (e: any) {
      setApplyError(e?.message || "Bulk reclass failed");
    } finally {
      setApplying(false);
    }
  }

  // Post-apply summary.
  if (result) {
    const parts: string[] = [`${result.moved_txns} moved`];
    if (result.rules_created) parts.push(`${result.rules_created} rule${result.rules_created === 1 ? "" : "s"} created`);
    if (result.rules_updated) parts.push(`${result.rules_updated} rule${result.rules_updated === 1 ? "" : "s"} updated`);
    if (result.skipped_closed) parts.push(`${result.skipped_closed} in closed period`);
    if (result.skipped_stale) parts.push(`${result.skipped_stale} changed since (kept)`);
    if (result.skipped_unsupported) parts.push(`${result.skipped_unsupported} not movable here`);
    if (result.skipped_no_source_line) parts.push(`${result.skipped_no_source_line} already moved`);
    if (result.failed) parts.push(`${result.failed} failed`);
    return (
      <div className="border-t border-gray-200 px-5 py-3 bg-emerald-50">
        <div className="flex items-start gap-2 text-xs">
          <CheckCircle2 size={15} className="text-emerald-600 shrink-0 mt-0.5" />
          <div className="text-emerald-900">
            <span className="font-bold">Done — {parts.join(" · ")}.</span>
            {result.skipped_unsupported > 0 && (
              <div className="mt-1 text-emerald-800">
                Transactions like deposits, transfers and journal entries can&apos;t be moved from
                this tool — open them in QuickBooks.
              </div>
            )}
            <button
              onClick={() => setResult(null)}
              className="mt-1.5 text-teal font-semibold hover:underline"
            >
              Reclass more
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 px-5 py-3 bg-teal-lighter/30">
      <div className="flex items-center gap-2 mb-2 text-xs font-bold text-navy">
        <ArrowRight size={14} className="text-teal" />
        Move {selectedCount} transaction{selectedCount === 1 ? "" : "s"} to a new account
      </div>

      {/* Target account picker */}
      <div className="relative mb-2">
        <input
          type="text"
          value={pickerOpen ? search : target ? `${target.name}` : ""}
          onChange={(e) => {
            setSearch(e.target.value);
            setPickerOpen(true);
          }}
          onFocus={() => setPickerOpen(true)}
          placeholder={accountsError || (accounts === null ? "Loading accounts…" : "Search accounts (P&L or Balance Sheet)…")}
          disabled={accounts === null || !!accountsError || applying}
          className="w-full text-xs border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal/40"
        />
        {pickerOpen && accounts && (
          <div className="absolute bottom-full left-0 right-0 mb-1 max-h-60 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg z-20">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-ink-slate">No matching accounts</div>
            ) : (
              filtered.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    setTarget(a);
                    setPickerOpen(false);
                    setSearch("");
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-teal-lighter/40 flex items-center justify-between gap-2"
                >
                  <span className="truncate text-navy">{a.fullyQualifiedName}</span>
                  <span className="shrink-0 text-[10px] font-bold uppercase text-ink-slate">
                    {isPL(a) ? "P&L" : "BS"}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 mb-2 text-xs text-navy cursor-pointer">
        <input
          type="checkbox"
          checked={createRule}
          onChange={(e) => setCreateRule(e.target.checked)}
          disabled={applying}
          className="accent-teal"
        />
        Create a rule so these vendors auto-categorize to{" "}
        <span className="font-semibold">{target ? target.name : "the new account"}</span> next time
      </label>

      {applyError && (
        <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {applyError}
        </div>
      )}

      <button
        onClick={apply}
        disabled={!target || applying}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-teal text-white text-xs font-bold hover:bg-teal-dark disabled:opacity-50"
      >
        {applying ? (
          <>
            <Loader2 size={13} className="animate-spin" /> {progress || "Moving…"}
          </>
        ) : (
          <>
            <ArrowRight size={13} /> Move {selectedCount} to {target ? target.name : "…"}
          </>
        )}
      </button>
    </div>
  );
}

function formatCurrencyExact(n: number): string {
  // Cent-precision for the drill-down — drill view is where bookkeepers
  // verify amounts down to the penny, so the dashboard rounding doesn't
  // apply.
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function DoubleLinkControl({
  clientLinkId,
  doubleName,
  isLinked,
  canUnlink,
}: {
  clientLinkId: string;
  doubleName: string | null;
  isLinked: boolean;
  canUnlink: boolean;
}) {
  const router = useRouter();
  const [unlinking, setUnlinking] = useState(false);

  // Not yet linked → keep the original CTA. Mirrors the prior single-button
  // behaviour so unmatched clients see no change.
  if (!isLinked) {
    return (
      <Link
        href={`/clients/${clientLinkId}/match-double`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy border border-gray-200 hover:border-gray-300 bg-white px-3 py-2 rounded-lg transition-colors"
      >
        <SettingsIcon size={14} />
        Match to Double
      </Link>
    );
  }

  // Linked → show the bound name as a badge, plus an Unlink CTA (admin/lead
  // only). The badge is a Link to /match-double so a re-match flow stays
  // one click away even before unlinking.
  async function handleUnlink() {
    if (!doubleName) return;
    if (
      !confirm(
        `Unlink "${doubleName}" from this client?\n\n` +
        `This removes the Double Finance association. You can re-match at ` +
        `any time. SNAP's Double sync (reclass completion, end-close pulls, ` +
        `etc) will stop until a new match is made.`
      )
    ) {
      return;
    }
    setUnlinking(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/unlink-double`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Unlink failed");
        setUnlinking(false);
        return;
      }
      // Server-rendered page → force a refresh so the chip flips back to
      // "Match to Double" without manual reload.
      router.refresh();
    } catch (e: any) {
      alert(e?.message || "Unlink failed");
      setUnlinking(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-1">
      <Link
        href={`/clients/${clientLinkId}/match-double`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 border border-emerald-300 hover:border-emerald-500 bg-emerald-50 hover:bg-emerald-100 px-3 py-2 rounded-lg transition-colors max-w-[260px]"
        title={`Linked to Double: ${doubleName}\nClick to re-match a different Double client`}
      >
        <SettingsIcon size={14} className="shrink-0" />
        <span className="truncate">
          Double: <span className="font-bold">{doubleName || "(unnamed)"}</span>
        </span>
      </Link>
      {canUnlink && (
        <button
          onClick={handleUnlink}
          disabled={unlinking}
          className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-800 border border-red-200 hover:border-red-400 bg-white hover:bg-red-50 px-2.5 py-2 rounded-lg transition-colors disabled:opacity-50"
          title="Unlink this client from Double (admin/lead only)"
        >
          {unlinking ? <Loader2 size={12} className="animate-spin" /> : <XIcon size={12} />}
          Unlink
        </button>
      )}
    </div>
  );
}

function ViewAsClientButton({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(false);

  async function handleViewAs() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/impersonate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to start impersonation");
        setLoading(false);
        return;
      }
      // Open the portal in a new tab so the bookkeeper doesn't lose the
      // internal context they were just looking at.
      window.open(data.redirect || "/portal", "_blank");
    } catch (e: any) {
      alert(e?.message || "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleViewAs}
      disabled={loading}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark border border-teal/40 hover:border-teal bg-white px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
      title="Open this client's portal in a new tab as if you were them — for QA, screenshots, or debugging what they see"
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
      View as client
    </button>
  );
}

// ─── ONBOARDING DETAILS ────────────────────────────────────────────────
// The GHL onboarding-form answers + call status, carried over when the client
// was created from the onboarding board. Lets a senior reference everything
// the client told us at signup without opening GoHighLevel.
function OnboardingDetailsCard({ onboarding }: { onboarding: OnboardingProfile }) {
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
  const fmtDT = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

  const attended = !!onboarding.ob_call_attended_at || onboarding.ob_call_status === "attended";
  const callLine = attended
    ? `Onboarding call attended${onboarding.ob_call_time ? ` · ${fmtDT(onboarding.ob_call_time)}` : ""}`
    : onboarding.ob_call_status === "cancelled"
    ? "Onboarding call cancelled"
    : onboarding.ob_call_time
    ? `Onboarding call booked · ${fmtDT(onboarding.ob_call_time)}`
    : "Onboarding call not booked";

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-navy flex items-center gap-2">
          <FileText size={15} className="text-teal" />
          Onboarding details
        </h3>
        <span className="text-[11px] text-ink-light">from GoHighLevel</span>
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-[11px]">
        {onboarding.won_at && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-lighter text-teal font-semibold">
            <CheckCircle2 size={11} /> Won {fmt(onboarding.won_at)}
          </span>
        )}
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
            onboarding.ob_form_submitted_at ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
          }`}
        >
          <FileText size={11} /> {onboarding.ob_form_submitted_at ? `Form ${fmt(onboarding.ob_form_submitted_at)}` : "Form pending"}
        </span>
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
            attended ? "bg-emerald-50 text-emerald-700" : onboarding.ob_call_status === "cancelled" ? "bg-red-50 text-red-700" : "bg-gray-50 text-ink-slate"
          }`}
        >
          <Clock size={11} /> {callLine}
        </span>
      </div>

      {onboarding.answers.length > 0 ? (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
          {onboarding.answers.map((a, i) => (
            <div key={i} className="min-w-0">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-ink-light">{a.label}</dt>
              <dd className="text-sm text-navy break-words whitespace-pre-wrap">{a.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-ink-slate italic">
          {onboarding.ob_form_submitted_at
            ? "Form submitted — no displayable answers captured."
            : "Onboarding form not submitted yet."}
        </p>
      )}
    </div>
  );
}
