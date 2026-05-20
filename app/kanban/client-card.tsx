"use client";

import { useState } from "react";
import {
  MessageSquare, Clock, Zap, AlertCircle, CheckCircle2,
  Loader2, MoreHorizontal, PauseCircle,
} from "lucide-react";
import type { KanbanCard } from "./types";

interface ClientCardProps {
  card: KanbanCard;
  stage: string;
  onOpen: (card: KanbanCard) => void;
  onRefresh: () => void;
  canEdit: boolean;
}

export function ClientCard({ card, stage, onOpen, onRefresh, canEdit }: ClientCardProps) {
  const [acting, setActing] = useState(false);

  const jobStatus = card.latest_reclass_job?.status || card.latest_coa_job?.status;
  const hasFailed = jobStatus === "failed";

  const daysSinceStripeRequest = card.stripe_request_sent_at
    ? Math.floor((Date.now() - new Date(card.stripe_request_sent_at).getTime()) / 86400000)
    : null;

  async function act(endpoint: string, body?: object) {
    setActing(true);
    try {
      await fetch(`/api/clients/${card.id}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      onRefresh();
    } finally {
      setActing(false);
    }
  }

  return (
    <div
      className="bg-white rounded-xl border border-gray-100 shadow-sm p-3.5 cursor-pointer hover:border-teal/40 hover:shadow-md transition-all group"
      onClick={() => onOpen(card)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-navy leading-tight truncate">
            {card.client_name}
          </div>
          <div className="text-xs text-ink-light mt-0.5">
            {card.jurisdiction}{card.state_province ? ` · ${card.state_province}` : ""}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onOpen(card); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-100 transition-all flex-shrink-0"
        >
          <MoreHorizontal size={14} className="text-ink-slate" />
        </button>
      </div>

      {/* Badges row */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
        {/* Stripe badge — only shown when detected, pending, or connected */}
        {card.stripe_detected && (
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
              card.stripe_connected
                ? "bg-green-50 text-green-700 border border-green-200"
                : card.stripe_pending
                ? "bg-blue-50 text-blue-700 border border-blue-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}
          >
            <Zap size={9} />
            {card.stripe_connected ? "Stripe ✓" : card.stripe_pending ? "Stripe pending" : "Stripe needed"}
          </span>
        )}

        {/* Failed job badge */}
        {hasFailed && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
            <AlertCircle size={9} />
            Job failed
          </span>
        )}

        {/* Due date */}
        {card.due_date && (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-ink-slate">
            <Clock size={9} />
            {card.due_date}
          </span>
        )}
      </div>

      {/* Awaiting stripe: days counter */}
      {stage === "awaiting_stripe" && daysSinceStripeRequest !== null && (
        <div
          className={`text-xs font-semibold mb-2.5 ${
            daysSinceStripeRequest >= 5 ? "text-red-600" : "text-amber-600"
          }`}
        >
          {daysSinceStripeRequest === 0
            ? "Request sent today"
            : `Waiting ${daysSinceStripeRequest}d`}
        </div>
      )}

      {/* Footer: bookkeeper + notes */}
      <div className="flex items-center justify-between mt-1">
        {card.bookkeeper ? (
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-5 rounded-full bg-teal flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
              {card.bookkeeper.full_name.charAt(0)}
            </div>
            <span className="text-[11px] text-ink-slate truncate max-w-[90px]">
              {card.bookkeeper.full_name.split(" ")[0]}
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-ink-light italic">Unassigned</span>
        )}

        {card.note_count > 0 && (
          <div className="flex items-center gap-1 text-[11px] text-ink-slate">
            <MessageSquare size={11} />
            {card.note_count}
          </div>
        )}
      </div>

      {/* Action button — rendered based on stage, stops click propagation */}
      <ActionButton
        stage={stage}
        card={card}
        acting={acting}
        canEdit={canEdit}
        onAct={act}
        onOpen={() => onOpen(card)}
      />
    </div>
  );
}

function ActionButton({
  stage, card, acting, canEdit, onAct, onOpen,
}: {
  stage: string;
  card: KanbanCard;
  acting: boolean;
  canEdit: boolean;
  onAct: (endpoint: string, body?: object) => void;
  onOpen: () => void;
}) {
  const btn = (label: string, onClick: () => void, variant: "primary" | "secondary" = "secondary") => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={acting}
      className={`mt-2.5 w-full text-xs font-semibold py-1.5 px-3 rounded-lg transition-colors disabled:opacity-50 ${
        variant === "primary"
          ? "bg-teal hover:bg-teal-dark text-white"
          : "border border-gray-200 hover:border-gray-300 text-ink-slate hover:text-navy bg-white"
      }`}
    >
      {acting ? <Loader2 size={11} className="animate-spin mx-auto" /> : label}
    </button>
  );

  if (stage === "needs_cleanup") {
    return btn("Start Cleanup →", () => window.location.href = `/jobs/new?client=${card.id}`, "primary");
  }

  if (stage === "coa_in_progress" && card.latest_coa_job) {
    return btn("Continue COA →", () => window.location.href = `/jobs/${card.latest_coa_job!.id}/review`);
  }

  if (stage === "reclass_in_progress") {
    if (card.latest_reclass_job) {
      return btn("Continue Reclass →", () => window.location.href = `/reclass/${card.latest_reclass_job!.id}/review`);
    }
    return btn("Start Reclass →", () => window.location.href = `/reclass/new?client=${card.id}`, "primary");
  }

  if (stage === "review") {
    return (
      <div className="mt-2.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          disabled={acting}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className="w-full text-xs font-semibold py-1.5 px-3 rounded-lg bg-teal hover:bg-teal-dark text-white transition-colors disabled:opacity-50"
        >
          {acting ? <Loader2 size={11} className="animate-spin mx-auto" /> : "Close & Move to MoM →"}
        </button>
        {card.stripe_detected && !card.stripe_connected && (
          <button
            disabled={acting}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="w-full text-xs font-semibold py-1.5 px-3 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 bg-white transition-colors disabled:opacity-50"
          >
            Request Stripe Connection
          </button>
        )}
      </div>
    );
  }

  if (stage === "awaiting_stripe") {
    return btn("Resend Link", () => onOpen());
  }

  // MoM stages
  if (stage === "month_open") {
    return btn("Start This Month →", () => window.location.href = `/reclass/new?client=${card.id}`, "primary");
  }

  if (stage === "in_progress" && card.latest_reclass_job) {
    return btn("Continue →", () => window.location.href = `/reclass/${card.latest_reclass_job!.id}/review`);
  }

  if (stage === "review_send" && card.latest_reclass_job) {
    return btn("Close Month ✓", () => onOpen(), "primary");
  }

  return null;
}
