"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2, AlertTriangle, FileText, Sparkles, ChevronRight, ChevronDown,
  ArrowLeft, Wallet, X,
} from "lucide-react";

interface Candidate {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_name: string | null;
  txn_date: string;
  balance: number;
  total_amount: number;
  reason?: string;
}

interface Match {
  id: string;
  job_id: string;
  qbo_payment_id: string;
  uf_customer_name: string | null;
  uf_amount: number;
  uf_date: string;
  uf_memo: string | null;
  uf_invoice_reference: string | null;
  match_kind: "exact_invoice_number" | "high_confidence" | "low_confidence" | "unmatched";
  confidence: number;
  proposed_invoices: Candidate[];
  candidate_invoices: Candidate[];
  decision: string;
  reasoning: string;
  bookkeeper_override: boolean;
  selected_invoice_id: string | null;
}

interface Job {
  id: string;
  client_link_id: string;
  uf_transactions_scanned: number;
  open_invoices_scanned: number;
  matches_exact: number;
  matches_high_confidence: number;
  matches_low_confidence: number;
  unmatched_count: number;
}

/**
 * UF → A/R match review. Four sections grouped by kind so the
 * bookkeeper can blast through the easy ones and slow down on the
 * ambiguous ones.
 *
 * Note: Execution against QBO (actually applying the payment to the
 * invoice via /payment update) is a follow-up. This commit ships the
 * review surface so the bookkeeper can see the matches and pick
 * candidates; the execute step comes next.
 */
export function UFARReview({
  job,
  matches: initialMatches,
  clientLinkId,
}: {
  job: Job;
  matches: Match[];
  clientLinkId: string;
}) {
  const [matches, setMatches] = useState<Match[]>(initialMatches);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["exact", "high"])
  );

  function toggleSection(key: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const groups = {
    exact: matches.filter((m) => m.match_kind === "exact_invoice_number"),
    high: matches.filter((m) => m.match_kind === "high_confidence"),
    low: matches.filter((m) => m.match_kind === "low_confidence"),
    unmatched: matches.filter((m) => m.match_kind === "unmatched"),
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(n);

  return (
    <div className="space-y-5">
      <Link
        href={`/balance-sheet/${clientLinkId}`}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy"
      >
        <ArrowLeft size={12} /> Back to Balance Sheet
      </Link>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <SummaryCard
          label="Exact invoice matches"
          value={groups.exact.length}
          color="#16A34A"
          bg="#DCFCE7"
        />
        <SummaryCard
          label="High-confidence"
          value={groups.high.length}
          color="#0891B2"
          bg="#CFFAFE"
        />
        <SummaryCard
          label="Need review"
          value={groups.low.length}
          color="#F59E0B"
          bg="#FEF3C7"
        />
        <SummaryCard
          label="Unmatched"
          value={groups.unmatched.length}
          color="#64748B"
          bg="#F1F5F9"
        />
      </div>

      {/* Heads-up: execute is pending */}
      <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
        <strong>Heads up:</strong> this is the review surface. Applying
        these matches against QBO Invoices is in the next iteration —
        for now you can see the recommendations and audit them. When the
        execute step ships, every &quot;auto-approve&quot; row will fire in one
        click.
      </div>

      {/* Groups */}
      <Section
        kind="exact"
        title="Exact invoice number matches"
        subtitle="Memo references a specific invoice number. Highest confidence."
        accentColor="#16A34A"
        accentBg="#DCFCE7"
        icon={CheckCircle2}
        matches={groups.exact}
        open={expandedSections.has("exact")}
        onToggle={() => toggleSection("exact")}
        fmt={fmt}
      />
      <Section
        kind="high"
        title="High-confidence (customer + exact amount)"
        subtitle="Single open invoice for this customer that matches the payment amount exactly."
        accentColor="#0891B2"
        accentBg="#CFFAFE"
        icon={Sparkles}
        matches={groups.high}
        open={expandedSections.has("high")}
        onToggle={() => toggleSection("high")}
        fmt={fmt}
      />
      <Section
        kind="low"
        title="Need review — pick from candidates"
        subtitle="Multiple plausible invoices, or amount doesn't exactly match. Bookkeeper picks."
        accentColor="#F59E0B"
        accentBg="#FEF3C7"
        icon={AlertTriangle}
        matches={groups.low}
        open={expandedSections.has("low")}
        onToggle={() => toggleSection("low")}
        fmt={fmt}
      />
      <Section
        kind="unmatched"
        title="Unmatched"
        subtitle="No open invoices found. Likely a refund, a deposit unrelated to A/R, or a customer with no outstanding balance."
        accentColor="#64748B"
        accentBg="#F1F5F9"
        icon={X}
        matches={groups.unmatched}
        open={expandedSections.has("unmatched")}
        onToggle={() => toggleSection("unmatched")}
        fmt={fmt}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
  bg,
}: {
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <div
      className="rounded-xl border p-3"
      style={{ backgroundColor: bg, borderColor: `${color}33` }}
    >
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-[11px] font-semibold mt-1" style={{ color }}>
        {label}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  accentColor,
  accentBg,
  icon: Icon,
  matches,
  open,
  onToggle,
  fmt,
}: {
  kind: string;
  title: string;
  subtitle: string;
  accentColor: string;
  accentBg: string;
  icon: any;
  matches: Match[];
  open: boolean;
  onToggle: () => void;
  fmt: (n: number) => string;
}) {
  if (matches.length === 0) return null;
  return (
    <div className="rounded-2xl bg-white border border-gray-200 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-5 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
      >
        <div
          className="rounded-lg p-1.5 flex-shrink-0"
          style={{ backgroundColor: accentBg }}
        >
          <Icon size={14} style={{ color: accentColor }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-navy">{title}</div>
          <div className="text-xs text-ink-slate mt-0.5">{subtitle}</div>
        </div>
        <span
          className="text-xs font-bold px-2 py-0.5 rounded-full"
          style={{ backgroundColor: accentBg, color: accentColor }}
        >
          {matches.length}
        </span>
        {open ? (
          <ChevronDown size={16} className="text-ink-slate" />
        ) : (
          <ChevronRight size={16} className="text-ink-slate" />
        )}
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {matches.map((m) => (
            <MatchRow key={m.id} match={m} fmt={fmt} accentColor={accentColor} />
          ))}
        </div>
      )}
    </div>
  );
}

function MatchRow({
  match,
  fmt,
  accentColor,
}: {
  match: Match;
  fmt: (n: number) => string;
  accentColor: string;
}) {
  const [showCandidates, setShowCandidates] = useState(false);
  const proposed = match.proposed_invoices?.[0];
  const candidateCount = match.candidate_invoices?.length || 0;

  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-4">
        {/* Left: UF payment */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Wallet size={13} className="text-ink-slate flex-shrink-0" />
            <span className="text-sm font-bold text-navy truncate">
              {match.uf_customer_name || "(No customer)"}
            </span>
            <span className="text-sm font-mono font-semibold text-navy">
              {fmt(match.uf_amount)}
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-light">
              {match.uf_date}
            </span>
          </div>
          {match.uf_memo && (
            <div className="text-xs text-ink-slate mt-1 truncate">
              <span className="font-semibold">Memo:</span> {match.uf_memo}
            </div>
          )}
          {match.uf_invoice_reference && (
            <div className="text-xs text-ink-slate mt-0.5">
              <span className="font-semibold">Parsed invoice ref:</span>{" "}
              <span className="font-mono">#{match.uf_invoice_reference}</span>
            </div>
          )}
        </div>

        {/* Right: proposed match */}
        <div className="flex-1 min-w-0">
          {proposed ? (
            <div
              className="rounded-lg border p-2.5"
              style={{
                backgroundColor: "#F9FAFB",
                borderColor: `${accentColor}33`,
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <FileText size={12} className="text-ink-slate flex-shrink-0" />
                <span className="text-xs font-bold text-navy">
                  Apply to invoice
                  {proposed.doc_number ? ` #${proposed.doc_number}` : ""}
                </span>
                <span className="text-xs font-mono text-ink-slate">
                  {fmt(proposed.balance)}
                </span>
              </div>
              <div className="text-[11px] text-ink-slate leading-relaxed">
                {proposed.reason || "(No reasoning recorded)"}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5 text-[11px] text-ink-slate">
              {match.reasoning}
            </div>
          )}

          {candidateCount > 1 && (
            <button
              onClick={() => setShowCandidates((v) => !v)}
              className="text-[11px] font-semibold text-teal hover:text-teal-dark mt-1.5"
            >
              {showCandidates ? "Hide" : "Show"} {candidateCount} candidate
              {candidateCount === 1 ? "" : "s"}
            </button>
          )}

          {showCandidates && (
            <div className="mt-2 space-y-1.5">
              {(match.candidate_invoices || []).map((c) => (
                <div
                  key={c.qbo_invoice_id}
                  className="rounded border border-gray-200 bg-white p-2 text-[11px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-navy">
                      {c.doc_number ? `#${c.doc_number}` : c.qbo_invoice_id}
                    </span>
                    <span className="font-mono text-ink-slate">
                      {fmt(c.balance)}
                    </span>
                    <span className="text-ink-light">{c.txn_date}</span>
                  </div>
                  {c.reason && (
                    <div className="text-ink-slate mt-0.5">{c.reason}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
