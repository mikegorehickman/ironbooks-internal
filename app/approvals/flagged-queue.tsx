"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Flag, Check, X, Edit3, Loader2, MapPin, User, FilePlus2, Shuffle,
  CreditCard, ChevronDown, ChevronRight, Sparkles, AlertTriangle,
} from "lucide-react";

export type FlaggedSource = "coa" | "reclass" | "stripe";

export interface FlaggedItem {
  id: string;
  type: FlaggedSource;
  source: FlaggedSource;       // duplicate of `type` for explicit grouping
  job_id: string;
  job_status: string;
  bookkeeper_name: string;
  job_created_at: string;
  headline: string;
  subheadline: string;
  amount: number | null;
  date: string | null;
  ai_reasoning: string | null;
  flagged_reason: string | null;
  ai_confidence: number | null;
  ai_suggested_target: string | null;
  transaction_count: number | null;
  raw: any;
}

export interface FlaggedClient {
  key: string;
  client_link_id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string;
  sources: FlaggedSource[];        // unique sources represented
  bookkeeper_names: string[];      // unique bookkeepers across all jobs
  job_ids: string[];               // every job_id contributing items
  latest_activity_at: string;      // most recent job's created_at
  items: FlaggedItem[];
}

const SOURCE_META: Record<FlaggedSource, { icon: any; label: string; color: string; bg: string }> = {
  coa:     { icon: FilePlus2,  label: "COA Cleanup",  color: "#2D7A75", bg: "#E8F2F0" },
  reclass: { icon: Shuffle,    label: "Reclassify",   color: "#0891B2", bg: "#CFFAFE" },
  stripe:  { icon: CreditCard, label: "Stripe Recon", color: "#7C3AED", bg: "#EDE9FE" },
};

export function FlaggedQueue({
  clients: initialClients,
  reviewerName,
}: {
  clients: FlaggedClient[];
  reviewerName: string;
}) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function resolveItem(
    client: FlaggedClient,
    item: FlaggedItem,
    decision: "approve" | "override" | "reject",
    overrideTarget?: string,
    notes?: string
  ) {
    const res = await fetch("/api/flagged/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: item.type,
        item_id: item.id,
        decision,
        override_target: overrideTarget,
        notes,
      }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Unknown error" }));
      alert(`Failed: ${error}`);
      return;
    }
    // Remove the item from this client's bucket; drop the client if empty.
    setClients((prev) =>
      prev
        .map((c) =>
          c.key === client.key
            ? { ...c, items: c.items.filter((it) => it.id !== item.id) }
            : c
        )
        .filter((c) => c.items.length > 0)
    );
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-ink-slate px-1">
        <Sparkles size={11} className="inline mr-1 text-teal" />
        Logged in as <span className="font-semibold text-navy">{reviewerName}</span>. All resolutions
        are written to the audit log.
      </div>

      {clients.map((client) => {
        const isExpanded = expanded.has(client.key);

        // Items grouped by source so the expanded panel reads as
        // "COA Cleanup (N) | Reclassify (M) | Stripe Recon (K)"
        // instead of a flat mix.
        const byCategory = new Map<FlaggedSource, FlaggedItem[]>();
        for (const it of client.items) {
          const arr = byCategory.get(it.source) || [];
          arr.push(it);
          byCategory.set(it.source, arr);
        }

        return (
          <div
            key={client.key}
            className="rounded-xl bg-white border border-gray-200 overflow-hidden"
          >
            {/* Client summary header (always visible). Aggregates every
                flagged item across COA / reclass / stripe and across
                multiple jobs into a single row. */}
            <button
              onClick={() => toggleExpanded(client.key)}
              className="w-full px-5 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors text-left"
            >
              <div className="flex-shrink-0">
                {isExpanded
                  ? <ChevronDown size={16} className="text-ink-slate" />
                  : <ChevronRight size={16} className="text-ink-slate" />}
              </div>

              <div className="rounded-lg flex items-center justify-center w-10 h-10 flex-shrink-0 bg-amber-100">
                <Flag size={18} className="text-amber-700" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-base text-navy">{client.client_name}</h3>
                  {client.sources.map((s) => {
                    const sMeta = SOURCE_META[s];
                    return (
                      <span
                        key={s}
                        className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{ color: sMeta.color, backgroundColor: sMeta.bg }}
                        title={`${(byCategory.get(s) || []).length} flagged ${sMeta.label} item(s)`}
                      >
                        {sMeta.label} · {(byCategory.get(s) || []).length}
                      </span>
                    );
                  })}
                </div>
                <div className="text-xs text-ink-slate flex items-center gap-3 mt-1 flex-wrap">
                  <span className="flex items-center gap-1">
                    <User size={11} />
                    {client.bookkeeper_names.slice(0, 2).join(", ")}
                    {client.bookkeeper_names.length > 2 && ` +${client.bookkeeper_names.length - 2}`}
                  </span>
                  <span className="flex items-center gap-1">
                    <MapPin size={11} /> {client.jurisdiction}
                    {client.state_province ? ` · ${client.state_province}` : ""}
                  </span>
                  <span>
                    {client.job_ids.length} job{client.job_ids.length !== 1 ? "s" : ""}
                  </span>
                  <span>
                    Last activity {new Date(client.latest_activity_at).toLocaleDateString()}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="rounded-full bg-amber-100 text-amber-800 text-xs font-bold px-2.5 py-1">
                  {client.items.length} {client.items.length === 1 ? "item" : "items"}
                </span>
              </div>
            </button>

            {/* Expanded item list — grouped by source within the client */}
            {isExpanded && (
              <div className="border-t border-gray-100">
                {(["coa", "reclass", "stripe"] as FlaggedSource[]).map((src) => {
                  const list = byCategory.get(src);
                  if (!list || list.length === 0) return null;
                  const sMeta = SOURCE_META[src];
                  const SIcon = sMeta.icon;
                  return (
                    <div key={src} className="border-b border-gray-100 last:border-0">
                      <div
                        className="px-5 py-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider"
                        style={{ color: sMeta.color, backgroundColor: sMeta.bg }}
                      >
                        <SIcon size={13} />
                        {sMeta.label}
                        <span className="text-[10px] font-semibold opacity-70">
                          {list.length} item{list.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {list.map((item) => (
                          <ItemCard
                            key={`${item.type}::${item.id}`}
                            client={client}
                            item={item}
                            onResolve={(decision, overrideTarget, notes) =>
                              resolveItem(client, item, decision, overrideTarget, notes)
                            }
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Inline-bold renderer. Lets `summarizeFlag` write copy with `**markers**`
 * around account names, suggested targets, and decision verbs, and have
 * those segments render as <strong> in the UI. Keeps the prose authored
 * as plain strings (easy to scan in the source) while letting the eye
 * lock onto the actionable terms on screen. No markdown library, no
 * sanitization headaches — the strings come from our own code.
 */
function Bold({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) {
          return (
            <strong key={i} className="font-bold text-navy">
              {p.slice(2, -2)}
            </strong>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/**
 * Decision kinds a flagged item can fall into. Drives the card's title,
 * fact rows, and which button set to show.
 *
 *  - qbo_blocked: The system tried to act and QBO refused (system-protected
 *    account, account has historical transactions, name collision, etc.).
 *    No Approve/Override path the API can take — bookkeeper either ignores
 *    it or fixes it manually in QBO. Buttons collapse to "Dismiss".
 *
 *  - ai_uncertain: AI's confidence was below the auto-approve threshold and
 *    the bookkeeper's actual judgment is needed. Approve / Override / Reject
 *    all make sense.
 *
 *  - info_only: Something happened that's worth knowing but isn't actionable
 *    here (e.g. "no QBO invoices within ±30 days of any Stripe deposit" for
 *    a client that doesn't invoice through QBO). Just dismiss.
 */
type FlagKind = "qbo_blocked" | "ai_uncertain" | "info_only";

function classifyFlag(item: FlaggedItem): FlagKind {
  const reason = `${item.flagged_reason || ""} ${item.ai_reasoning || ""}`.toLowerCase();

  // QBO platform refusals — these phrases come from lib/executor.ts and
  // lib/qbo.ts when QBO returns a 6xxx error or refuses an action.
  const qboBlockedPatterns = [
    "system-protected",
    "cannot be modified via api",
    "qbo requires manual",
    "manual cleanup required",
    "qbo blocks api",
    "qbo rejected",
    "skipping",
  ];
  if (qboBlockedPatterns.some((p) => reason.includes(p))) {
    return "qbo_blocked";
  }

  // Stripe recon "zero candidates" case — bookkeeper acknowledges and
  // either sends a Connect link or moves on, no per-row decision needed.
  if (item.type === "stripe" && /no qbo invoices.*within/.test(reason)) {
    return "info_only";
  }

  return "ai_uncertain";
}

interface FlagSummary {
  kind: FlagKind;
  /** Short banner headline above the card body. */
  title: string;
  /** What the system tried to do (or what's being asked), in plain English. */
  whatWasAttempted: string | null;
  /** The structured fact rows shown in the card body. */
  facts: Array<{ label: string; value: string }>;
  /** Plain-English next step the bookkeeper should take. */
  nextStep: string;
}

function summarizeFlag(item: FlaggedItem): FlagSummary {
  const kind = classifyFlag(item);

  if (item.type === "coa") {
    const facts: Array<{ label: string; value: string }> = [];
    facts.push({ label: "Account", value: `**${item.headline}**` });
    if (item.subheadline) facts.push({ label: "Type", value: item.subheadline });
    if (item.transaction_count !== null && item.transaction_count !== undefined) {
      facts.push({
        label: "Transactions",
        value: item.transaction_count === 0
          ? "**0** (none in cleanup range)"
          : `**${item.transaction_count}**`,
      });
    }
    if (item.ai_suggested_target) {
      facts.push({
        label: "AI wanted to map to",
        value: `**${item.ai_suggested_target}**`,
      });
    }
    if (item.flagged_reason || item.ai_reasoning) {
      facts.push({
        label: kind === "qbo_blocked" ? "Why QBO blocked it" : "Why AI flagged it",
        value: item.flagged_reason || item.ai_reasoning || "",
      });
    }

    if (kind === "qbo_blocked") {
      return {
        kind,
        title: "QBO blocked this — needs manual handling",
        whatWasAttempted: item.ai_suggested_target
          ? `Tried to map **${item.headline}** → **${item.ai_suggested_target}**`
          : `Tried to modify **${item.headline}**`,
        facts,
        nextStep:
          item.transaction_count && item.transaction_count > 0
            ? `Open **${item.headline}** in QBO. Either reclassify its **${item.transaction_count}** transactions then inactivate, or rename manually. Then click **Dismiss from queue**.`
            : `**${item.headline}** is system-protected — QBO won't accept changes via the API. Click **Dismiss from queue** to remove this flag. No further action needed.`,
      };
    }

    return {
      kind,
      title: "AI needs your input on this account",
      whatWasAttempted: item.ai_suggested_target
        ? `AI wants to map **${item.headline}** → **${item.ai_suggested_target}**, but isn't confident.`
        : `AI is unsure how to handle **${item.headline}**.`,
      facts,
      nextStep: item.ai_suggested_target
        ? `If **${item.ai_suggested_target}** is right, click **Approve**. To send it somewhere else, click **Pick a different target**. To leave **${item.headline}** alone, click **Leave as-is**.`
        : `Click **Pick a different target** to choose the right master account, or **Leave as-is** to skip.`,
    };
  }

  if (item.type === "reclass") {
    const amt = item.amount !== null ? `$${Math.abs(item.amount).toFixed(2)}` : "—";
    const facts: Array<{ label: string; value: string }> = [
      { label: "Vendor", value: `**${item.headline}**` },
      { label: "Amount", value: `**${amt}**` },
      ...(item.date ? [{ label: "Date", value: item.date }] : []),
      ...(item.subheadline ? [{ label: "Currently in", value: `**${item.subheadline}**` }] : []),
      ...(item.ai_suggested_target
        ? [{ label: "AI wants to move to", value: `**${item.ai_suggested_target}**` }]
        : []),
      ...(item.ai_reasoning
        ? [{ label: "AI reasoning", value: item.ai_reasoning }]
        : []),
    ];
    return {
      kind: "ai_uncertain",
      title: "Categorize this transaction",
      whatWasAttempted: item.ai_suggested_target
        ? `AI wants to move **${item.headline}** (${amt}) from **${item.subheadline || "current account"}** → **${item.ai_suggested_target}**.`
        : `AI couldn't confidently categorize **${item.headline}** (${amt}).`,
      facts,
      nextStep: item.ai_suggested_target
        ? `If **${item.ai_suggested_target}** is the right category, click **Approve**. Otherwise click **Pick a different target** to choose another account, or **Leave as-is** to keep it in **${item.subheadline || "the current account"}**.`
        : `Click **Pick a different target** to assign the right category, or **Leave as-is** to skip.`,
    };
  }

  // Stripe
  const amt = item.amount !== null ? `$${item.amount.toFixed(2)}` : "—";
  const customers =
    item.subheadline && item.subheadline !== "No customers matched"
      ? item.subheadline
      : null;
  const facts: Array<{ label: string; value: string }> = [
    { label: "Deposit amount", value: `**${amt}**` },
    ...(item.date ? [{ label: "Deposit date", value: item.date }] : []),
    {
      label: "Customers identified",
      value: customers ? `**${customers}**` : "**None** — AI couldn't match invoices",
    },
    ...(item.ai_reasoning
      ? [{ label: "Why AI flagged it", value: item.ai_reasoning }]
      : []),
  ];

  if (kind === "info_only") {
    return {
      kind,
      title: "Nothing to match — manual deposit",
      whatWasAttempted: `**${amt}** Stripe deposit with no matching QBO invoices.`,
      facts,
      nextStep:
        "This client doesn't invoice through QBO (Payment Links / subscriptions / direct charges). To reconcile, send them a **Stripe Connect** link from the sidebar. Otherwise click **Dismiss from queue**.",
    };
  }

  return {
    kind: "ai_uncertain",
    title: "Match this Stripe deposit",
    whatWasAttempted: customers
      ? `AI matched **${amt}** to ${customers} but isn't confident.`
      : `AI couldn't match this **${amt}** deposit to QBO invoices.`,
    facts,
    nextStep: customers
      ? `If those customers are right, click **Approve**. Otherwise click **Pick a different target** to choose specific invoices, or **Leave as-is** to skip.`
      : `Click **Pick a different target** to choose invoices manually, or **Leave as-is** to skip.`,
  };
}

function ItemCard({
  client,
  item,
  onResolve,
}: {
  client: FlaggedClient;
  item: FlaggedItem;
  onResolve: (decision: "approve" | "override" | "reject", overrideTarget?: string, notes?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "override" | "reject" | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideValue, setOverrideValue] = useState(item.ai_suggested_target || "");
  const [notes, setNotes] = useState("");

  const confidencePct = Math.round((item.ai_confidence || 0) * 100);
  const summary = summarizeFlag(item);

  async function handle(decision: "approve" | "override" | "reject", target?: string) {
    setBusy(decision);
    try {
      await onResolve(decision, target, notes || undefined);
    } finally {
      setBusy(null);
    }
  }

  // Card accent color follows the flag kind so the eye can scan the queue
  // and tell "this needs a real decision" from "this just needs dismissing"
  // without reading the body text.
  const kindStyles = {
    qbo_blocked: {
      iconColor: "text-red-600",
      titleColor: "text-red-900",
      bannerBg: "bg-red-50 border-red-200",
    },
    ai_uncertain: {
      iconColor: "text-amber-600",
      titleColor: "text-amber-900",
      bannerBg: "bg-amber-50 border-amber-200",
    },
    info_only: {
      iconColor: "text-ink-slate",
      titleColor: "text-navy",
      bannerBg: "bg-gray-50 border-gray-200",
    },
  }[summary.kind];

  // "AI confidence" only makes sense when the AI's confidence is the
  // problem. Hide it for QBO platform refusals — there the AI may have
  // been very confident, QBO just said no.
  const showConfidence = summary.kind === "ai_uncertain" && confidencePct > 0;

  return (
    <div className="px-5 py-4 hover:bg-gray-50 transition-colors">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 mt-1">
          <AlertTriangle size={16} className={kindStyles.iconColor} />
        </div>

        <div className="flex-1 min-w-0 space-y-2.5">
          {/* Row 1: intent header */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <h4 className={`font-bold text-sm ${kindStyles.titleColor}`}>
              {summary.title}
            </h4>
            <span
              className="text-[10px] font-semibold uppercase tracking-wider text-ink-light"
              title={`Job ${item.job_id.slice(0, 8)} · started ${new Date(item.job_created_at).toLocaleDateString()}`}
            >
              {item.job_status} · {item.bookkeeper_name}
            </span>
            {showConfidence && (
              <span
                className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded"
                style={{
                  color:           confidencePct >= 70 ? "#F59E0B" : "#DC2626",
                  backgroundColor: confidencePct >= 70 ? "#FEF3C7" : "#FEE2E2",
                }}
                title="AI's confidence in its own categorization"
              >
                AI {confidencePct}%
              </span>
            )}
          </div>

          {/* Row 2: what was attempted */}
          {summary.whatWasAttempted && (
            <div className="text-xs text-ink-slate">
              <span className="font-bold text-navy">What happened:</span>{" "}
              <Bold text={summary.whatWasAttempted} />
            </div>
          )}

          {/* Row 3: structured facts */}
          <div className={`rounded-lg border p-3 ${kindStyles.bannerBg}`}>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs leading-relaxed">
              {summary.facts.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="font-bold text-navy whitespace-nowrap">
                    {f.label}:
                  </dt>
                  <dd className="text-ink-slate break-words">
                    <Bold text={f.value} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Row 4: next step prose */}
          <div className="text-xs text-ink-slate flex items-start gap-1.5">
            <Sparkles size={11} className="text-teal flex-shrink-0 mt-0.5" />
            <span>
              <span className="font-bold text-navy">What to do: </span>
              <Bold text={summary.nextStep} />
            </span>
          </div>

          {/* Override input (only when open, only for ai_uncertain) */}
          {overrideOpen && summary.kind === "ai_uncertain" && (
            <div className="space-y-2">
              <input
                type="text"
                value={overrideValue}
                onChange={(e) => setOverrideValue(e.target.value)}
                placeholder={item.type === "coa" ? "Master account name (e.g. Paint & Materials)" : "Target account name"}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
              />
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional, recorded in audit log)"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-xs text-navy"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handle("override", overrideValue.trim() || undefined)}
                  disabled={!!busy || !overrideValue.trim()}
                  className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50"
                >
                  {busy === "override" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Save Override
                </button>
                <button
                  onClick={() => setOverrideOpen(false)}
                  className="text-xs font-semibold text-ink-slate hover:text-navy"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Decision buttons — set varies by flag kind */}
          {!overrideOpen && summary.kind === "ai_uncertain" && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handle("approve")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50"
                title="Use the AI's suggestion as-is"
              >
                {busy === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {item.ai_suggested_target
                  ? `Approve "${item.ai_suggested_target}"`
                  : "Approve AI suggestion"}
              </button>
              <button
                onClick={() => setOverrideOpen(true)}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 bg-white hover:bg-gray-50 text-navy border border-gray-200 text-xs font-semibold px-3 py-1.5 rounded-md"
              >
                <Edit3 size={12} /> Pick a different target
              </button>
              <button
                onClick={() => handle("reject")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 bg-white hover:bg-red-50 text-red-700 border border-red-200 text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50"
                title="Leave it as-is and remove from queue"
              >
                {busy === "reject" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Leave as-is
              </button>
            </div>
          )}

          {/* qbo_blocked + info_only: just a Dismiss button.
              Backed by the same /api/flagged/resolve "reject" decision so
              the row clears from every reviewer's queue. Optional notes
              capture the audit trail. */}
          {!overrideOpen && summary.kind !== "ai_uncertain" && (
            <div className="space-y-2">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional — recorded in audit log)"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-xs text-navy"
              />
              <button
                onClick={() => handle("reject")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 bg-white hover:bg-gray-50 disabled:opacity-60 border border-gray-200 text-navy text-xs font-semibold px-3 py-1.5 rounded-md"
                title="Acknowledge and remove from the queue"
              >
                {busy === "reject" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Dismiss from queue
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
