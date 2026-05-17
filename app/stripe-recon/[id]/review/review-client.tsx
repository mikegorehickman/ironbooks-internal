"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2, AlertTriangle, Flag, CreditCard, ChevronDown, ChevronRight,
  Loader2, Receipt, ArrowRight,
} from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

type Job = Database["public"]["Tables"]["stripe_recon_jobs"]["Row"];
type Match = Database["public"]["Tables"]["stripe_recon_matches"]["Row"];

interface InvoiceLine {
  invoice_id: string;
  customer_name: string | null;
  amount: number;
  pre_tax_amount?: number;
  tax_amount?: number;
}

export function StripeReconReview({
  job,
  matches: initialMatches,
  clientLink,
}: {
  job: Job;
  matches: Match[];
  clientLink: { client_name: string; jurisdiction: string; state_province: string | null };
}) {
  const router = useRouter();
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [filter, setFilter] = useState<"all" | "auto_approve" | "needs_review" | "flagged">("needs_review");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const counts = {
    auto: matches.filter((m) => m.decision === "auto_approve").length,
    review: matches.filter((m) => m.decision === "needs_review").length,
    flagged: matches.filter((m) => m.decision === "flagged").length,
  };

  const filtered = filter === "all" ? matches : matches.filter((m) => m.decision === filter);

  async function setDecision(matchId: string, newDecision: Match["decision"]) {
    setMatches((prev) =>
      prev.map((m) =>
        m.id === matchId ? { ...m, decision: newDecision, bookkeeper_override: true } : m
      )
    );
    await supabase
      .from("stripe_recon_matches")
      .update({ decision: newDecision, bookkeeper_override: true })
      .eq("id", matchId);
  }

  async function executeRecon() {
    const approvedCount = matches.filter((m) => m.decision === "auto_approve").length;
    if (approvedCount === 0) {
      alert("No matches are set to 'Auto-approve'. Set at least one before executing.");
      return;
    }
    if (!confirm(`Apply ${approvedCount} approved match${approvedCount === 1 ? "" : "es"} to QBO?\n\nThis will:\n• Update each Stripe deposit's memo with customer names\n• Add a negative line item for the Stripe processing fee${clientLink.jurisdiction === "CA" ? "\n• Add a separate line item for GST/HST recoverable on the fee" : ""}`)) {
      return;
    }
    setExecuting(true);
    try {
      const res = await fetch(`/api/stripe-recon/${job.id}/execute`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Could not start execution: ${data.error || `HTTP ${res.status}`}`);
        setExecuting(false);
        return;
      }
      router.push(`/stripe-recon/${job.id}/execute`);
    } catch (err: any) {
      alert(`Network error: ${err?.message || err}`);
      setExecuting(false);
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const totalDeposits = matches.reduce((s, m) => s + Number(m.deposit_amount || 0), 0);
  const totalInvoices = matches.reduce((s, m) => s + Number(m.total_invoice_amount || 0), 0);
  const totalPreTax = matches.reduce((s, m) => s + Number(m.pre_tax_revenue || 0), 0);
  const totalTaxCollected = matches.reduce((s, m) => s + Number(m.total_sales_tax_collected || 0), 0);
  const totalFees = matches.reduce((s, m) => s + Number(m.computed_fee || 0), 0);
  const totalTaxOnFees = matches.reduce((s, m) => s + Number(m.computed_tax || 0), 0);

  const isCanada = clientLink.jurisdiction === "CA";

  // Top-level warnings — surface job.warnings (set by the matcher when e.g.
  // most deposits had no QBO invoices in the window). Reading defensively
  // since it's a jsonb column that may be null or an array.
  const jobWarnings: string[] = Array.isArray((job as any).warnings)
    ? ((job as any).warnings as any[]).filter((w) => typeof w === "string")
    : [];

  return (
    <div>
      {jobWarnings.length > 0 && (
        <div className="mb-4 p-4 rounded-lg bg-amber-50 border border-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-1 text-sm text-amber-900">
              {jobWarnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className={`grid gap-3 mb-5 ${isCanada ? "grid-cols-5" : "grid-cols-3"}`}>
        <SummaryCard
          label="Stripe Deposits"
          value={`$${totalDeposits.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
          sub={`${matches.length} matched`}
        />
        <SummaryCard
          label="Pre-Tax Revenue"
          value={`$${totalPreTax.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
          sub="To Painting Revenue"
          color="#10B981"
        />
        {isCanada && (
          <SummaryCard
            label="Sales Tax Collected"
            value={`$${totalTaxCollected.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
            sub={`To Tax Payable · ${clientLink.state_province ?? "CA"}`}
            color="#2563EB"
          />
        )}
        <SummaryCard
          label="Stripe Fees"
          value={`$${totalFees.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
          sub={isCanada ? "Pre-tax expense" : "Expense"}
          color="#7C3AED"
        />
        {isCanada && (
          <SummaryCard
            label="ITC on Fees"
            value={`$${totalTaxOnFees.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
            sub="Recoverable"
            color="#0891B2"
          />
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {[
          { id: "needs_review" as const, label: "Needs Review", count: counts.review, color: "#F59E0B" },
          { id: "auto_approve" as const, label: "Auto-approved", count: counts.auto, color: "#10B981" },
          { id: "flagged" as const, label: "Flagged", count: counts.flagged, color: "#DC2626" },
          { id: "all" as const, label: "All", count: matches.length, color: "#0F1F2E" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setFilter(t.id)}
            className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors capitalize ${
              filter === t.id
                ? "bg-navy text-white border border-navy"
                : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {/* Matches */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200 mb-6">
        {filtered.length === 0 && (
          <p className="text-sm text-ink-slate py-12 text-center">No matches in this tab.</p>
        )}
        {filtered.map((m) => (
          <MatchRow
            key={m.id}
            match={m}
            expanded={expanded.has(m.id)}
            onToggle={() => toggleExpanded(m.id)}
            onDecisionChange={(d) => setDecision(m.id, d)}
            isCanada={isCanada}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="flex justify-between items-center">
        <button onClick={() => router.back()} className="text-sm font-semibold text-ink-slate hover:text-navy">
          ← Back
        </button>
        <div className="flex items-center gap-3">
          <div className="text-xs text-ink-slate">
            {counts.auto} approved · {counts.review} pending review
          </div>
          <button
            onClick={executeRecon}
            disabled={executing || counts.auto === 0}
            className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            {executing ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
            {executing ? "Starting..." : `Execute ${counts.auto} Reconciliation${counts.auto === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="px-4 py-3 rounded-lg bg-white border border-gray-200">
      <div className="text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">{label}</div>
      <div className="text-xl font-bold" style={{ color: color || "#0F1F2E" }}>{value}</div>
      {sub && <div className="text-[10px] text-ink-light mt-0.5">{sub}</div>}
    </div>
  );
}

function MatchRow({
  match, expanded, onToggle, onDecisionChange, isCanada,
}: {
  match: Match;
  expanded: boolean;
  onToggle: () => void;
  onDecisionChange: (d: Match["decision"]) => void;
  isCanada: boolean;
}) {
  const decisionConfig = {
    auto_approve: { color: "#10B981", bg: "#D1FAE5", label: "Auto-approved", icon: CheckCircle2 },
    needs_review: { color: "#F59E0B", bg: "#FEF3C7", label: "Needs Review",  icon: AlertTriangle },
    flagged:      { color: "#DC2626", bg: "#FEE2E2", label: "Flagged",       icon: Flag },
  };
  const cfg = decisionConfig[match.decision];
  const Icon = cfg.icon;

  const confidencePct = Math.round((match.ai_confidence || 0) * 100);
  const invoiceList = (match.matched_invoices as any as InvoiceLine[]) || [];
  const feePct = match.total_invoice_amount && Number(match.total_invoice_amount) > 0
    ? ((Number(match.computed_fee) + Number(match.computed_tax)) / Number(match.total_invoice_amount)) * 100
    : 0;

  return (
    <div className="border-b border-gray-100 last:border-0">
      <div
        className="grid items-center px-5 py-3.5 hover:bg-teal-lighter cursor-pointer"
        style={{ gridTemplateColumns: "auto 1.2fr 2fr 1fr 0.8fr 1.2fr" }}
        onClick={onToggle}
      >
        {/* Chevron */}
        <div className="pr-2">
          {expanded ? <ChevronDown size={14} className="text-ink-slate" /> : <ChevronRight size={14} className="text-ink-slate" />}
        </div>

        {/* Deposit */}
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-sm text-navy">
            <CreditCard size={13} className="text-purple-500" />
            ${Number(match.deposit_amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-ink-slate">{match.deposit_date}</div>
        </div>

        {/* Customers */}
        <div className="pr-3">
          {(match.matched_customer_names || []).length === 0 ? (
            <span className="text-xs italic text-ink-light">No customers matched</span>
          ) : (
            <div className="text-sm font-semibold text-navy truncate">
              {(match.matched_customer_names || []).join(", ")}
            </div>
          )}
          {match.ai_reasoning && (
            <div
              className="text-[11px] mt-0.5 italic text-ink-slate line-clamp-3"
              title={match.ai_reasoning}
            >
              {match.ai_reasoning}
            </div>
          )}
        </div>

        {/* Fee */}
        <div>
          <div className="text-sm font-semibold text-purple-700">
            ${Number(match.computed_fee).toFixed(2)}
            {isCanada && Number(match.computed_tax) > 0 && (
              <span className="text-blue-600 ml-1">+ ${Number(match.computed_tax).toFixed(2)} tax</span>
            )}
          </div>
          {feePct > 0 && (
            <div className="text-[10px] text-ink-light">{feePct.toFixed(2)}% of gross</div>
          )}
        </div>

        {/* Confidence */}
        <div>
          <span
            className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold"
            style={{
              color:           confidencePct >= 90 ? "#10B981" : confidencePct >= 70 ? "#F59E0B" : "#DC2626",
              backgroundColor: confidencePct >= 90 ? "#D1FAE5" : confidencePct >= 70 ? "#FEF3C7" : "#FEE2E2",
            }}
          >
            {confidencePct}%
          </span>
        </div>

        {/* Decision */}
        <div onClick={(e) => e.stopPropagation()}>
          <select
            value={match.decision}
            onChange={(e) => onDecisionChange(e.target.value as Match["decision"])}
            className="text-xs font-semibold px-2 py-1 rounded border bg-white"
            style={{ color: cfg.color, borderColor: cfg.color, backgroundColor: cfg.bg }}
          >
            <option value="auto_approve">Auto-approve</option>
            <option value="needs_review">Needs Review</option>
            <option value="flagged">Flagged</option>
          </select>
        </div>
      </div>

      {/* Expanded breakdown — per-customer income, tax, fee, ITC */}
      {expanded && (
        <div className="px-5 pb-4 pt-2 bg-gray-50 border-t border-gray-100">
          <div className="text-xs font-bold uppercase tracking-wider text-ink-slate mb-2">
            Deposit decomposition
          </div>
          {invoiceList.length === 0 ? (
            <div className="text-sm text-ink-slate italic py-2">
              No invoices matched. May need manual placement in QBO.
            </div>
          ) : (
            <div className="space-y-1">
              {/* Per-customer income lines */}
              <div className="text-[10px] font-bold uppercase tracking-wider text-green-700 mt-1">
                Income (Painting Revenue)
              </div>
              {invoiceList.map((inv) => (
                <div key={inv.invoice_id} className="flex items-center justify-between text-sm bg-white rounded px-3 py-1.5 border border-gray-200">
                  <span className="text-navy">
                    {inv.customer_name || "Unknown"} · Invoice {inv.invoice_id}
                  </span>
                  <span className="font-semibold text-green-700">
                    +${Number(inv.pre_tax_amount ?? inv.amount).toFixed(2)}
                  </span>
                </div>
              ))}

              {/* Sales tax collected (Canada only) */}
              {isCanada && Number(match.total_sales_tax_collected) > 0 && (
                <div className="flex items-center justify-between text-sm bg-white rounded px-3 py-1.5 border border-blue-100 mt-1.5">
                  <span className="text-blue-800">
                    Sales tax collected {match.tax_code ? `(${match.tax_code})` : ""} — to Tax Payable
                  </span>
                  <span className="font-semibold text-blue-700">
                    +${Number(match.total_sales_tax_collected).toFixed(2)}
                  </span>
                </div>
              )}

              {/* Subtotal of positive lines */}
              <div className="flex items-center justify-between text-sm font-semibold pt-1.5 border-t border-gray-200">
                <span>Gross customer payments</span>
                <span>${Number(match.total_invoice_amount).toFixed(2)}</span>
              </div>

              {/* Negative — Stripe fee */}
              <div className="text-[10px] font-bold uppercase tracking-wider text-purple-700 mt-2">
                Stripe deductions
              </div>
              <div className="flex items-center justify-between text-sm bg-white rounded px-3 py-1.5 border border-purple-100">
                <span className="text-purple-800">
                  Stripe processing fee {isCanada ? "(pre-tax)" : ""} — to Bank Charges & Fees
                </span>
                <span className="font-semibold text-purple-700">
                  −${Number(match.computed_fee).toFixed(2)}
                </span>
              </div>
              {isCanada && Number(match.computed_tax) > 0 && (
                <div className="flex items-center justify-between text-sm bg-white rounded px-3 py-1.5 border border-cyan-100">
                  <span className="text-cyan-800">
                    {match.tax_code || "Tax"} on Stripe fee (ITC) — to Tax Receivable
                  </span>
                  <span className="font-semibold text-cyan-700">
                    −${Number(match.computed_tax).toFixed(2)}
                  </span>
                </div>
              )}

              {/* Net = bank deposit */}
              <div className="flex items-center justify-between text-sm font-bold pt-1.5 border-t border-gray-300">
                <span>Net to bank (Stripe deposit)</span>
                <span>${Number(match.deposit_amount).toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
