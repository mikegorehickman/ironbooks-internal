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

function buildContext(item: FlaggedItem): string {
  const parts: string[] = [];
  if (item.type === "coa") {
    parts.push(`Account "${item.headline}"${item.subheadline ? ` (${item.subheadline})` : ""}.`);
    if (item.transaction_count !== null && item.transaction_count !== undefined) {
      parts.push(`${item.transaction_count} transactions on it.`);
    }
    if (item.flagged_reason) {
      parts.push(`AI flagged: ${item.flagged_reason}`);
    } else if (item.ai_reasoning) {
      parts.push(`AI reasoning: ${item.ai_reasoning}`);
    }
    if (item.ai_suggested_target) {
      parts.push(`AI suggested target: "${item.ai_suggested_target}".`);
    }
  } else if (item.type === "reclass") {
    const amt = item.amount !== null ? `$${Math.abs(item.amount).toFixed(2)}` : "";
    parts.push(`${item.headline} charged ${amt} on ${item.date}.`);
    if (item.subheadline) parts.push(`Currently in "${item.subheadline}".`);
    if (item.ai_reasoning) parts.push(`AI reasoning: ${item.ai_reasoning}`);
  } else if (item.type === "stripe") {
    const amt = item.amount !== null ? `$${item.amount.toFixed(2)}` : "";
    parts.push(`Stripe deposit of ${amt} on ${item.date}.`);
    if (item.subheadline && item.subheadline !== "No customers matched") {
      parts.push(`Customers identified: ${item.subheadline}.`);
    } else {
      parts.push(`No customer invoices matched.`);
    }
    if (item.ai_reasoning) parts.push(`AI reasoning: ${item.ai_reasoning}`);
  }
  return parts.join(" ");
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
  const context = buildContext(item);

  async function handle(decision: "approve" | "override" | "reject", target?: string) {
    setBusy(decision);
    try {
      await onResolve(decision, target, notes || undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-5 py-4 hover:bg-gray-50 transition-colors">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 mt-1">
          <AlertTriangle size={16} className="text-amber-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h4 className="font-bold text-sm text-navy">{item.headline}</h4>
            {item.amount !== null && (
              <span className="text-sm font-semibold text-navy">
                ${Math.abs(item.amount).toFixed(2)}
              </span>
            )}
            {/* Tiny job context — shows which specific job this flag came
                from so reviewers can disambiguate when one client has
                multiple jobs of the same source contributing flags. */}
            <span
              className="text-[10px] font-semibold uppercase tracking-wider text-ink-light"
              title={`Job ${item.job_id.slice(0, 8)} · started ${new Date(item.job_created_at).toLocaleDateString()}`}
            >
              {item.job_status} · {item.bookkeeper_name}
            </span>
            {confidencePct > 0 && (
              <span
                className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded"
                style={{
                  color:           confidencePct >= 70 ? "#F59E0B" : "#DC2626",
                  backgroundColor: confidencePct >= 70 ? "#FEF3C7" : "#FEE2E2",
                }}
              >
                AI {confidencePct}%
              </span>
            )}
          </div>

          {/* AI context summary */}
          <div className="rounded-lg p-3 bg-amber-50 border border-amber-100 text-xs text-amber-900 leading-relaxed">
            <Sparkles size={11} className="inline mr-1 text-amber-600" />
            {context}
          </div>

          {/* Override input (only when open) */}
          {overrideOpen && (
            <div className="mt-3 space-y-2">
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

          {/* Decision buttons */}
          {!overrideOpen && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => handle("approve")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50"
                title="Accept AI's suggestion"
              >
                {busy === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Approve
              </button>
              <button
                onClick={() => setOverrideOpen(true)}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 bg-white hover:bg-gray-50 text-navy border border-gray-200 text-xs font-semibold px-3 py-1.5 rounded-md"
              >
                <Edit3 size={12} /> Override
              </button>
              <button
                onClick={() => handle("reject")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 bg-white hover:bg-red-50 text-red-700 border border-red-200 text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50"
                title="Reject / keep as-is"
              >
                {busy === "reject" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
