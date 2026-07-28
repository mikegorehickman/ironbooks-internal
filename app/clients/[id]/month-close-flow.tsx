"use client";

import Link from "next/link";
import { useState } from "react";
import { Shuffle, Mail, FileText, CheckCircle2, ArrowRight, Search, RotateCcw } from "lucide-react";
import { AskClientComposer } from "@/components/AskClientComposer";

/**
 * Fast month-close flow — a production client's monthly close in one place:
 * categorize the month's new transactions, ask any questions, request any
 * documents, then close. Reuses the existing tools (reclass, the shared
 * Ask-Client composer, /production close) so there's nothing new to learn —
 * it just puts the four steps in order so a bookkeeper can rip through a
 * month without hunting across the app.
 */
export function MonthCloseFlow({
  clientLinkId,
  clientName,
  onNavigateTab,
}: {
  clientLinkId: string;
  clientName: string;
  /** Jump to another tab on THIS client (statements live on the BS tab). */
  onNavigateTab?: (tab: "overview" | "bs" | "pl") => void;
}) {
  const [composer, setComposer] = useState<null | "ask" | "docs">(null);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-semibold text-navy">Close this month — {clientName}</div>
        <p className="text-xs text-ink-slate mt-0.5">
          Production client. Work top to bottom: tidy the month, clear up anything unclear with the
          client, then close.
        </p>
      </div>

      <div className="space-y-2">
        {/* 1 — Categorize */}
        <FlowStep
          num={1}
          title="Categorize this month's transactions"
          blurb="Review & re-map anything the daily engine left uncertain."
        >
          <Link
            href={`/reclass/new?client=${clientLinkId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
          >
            <Shuffle size={13} /> Categorize <ArrowRight size={12} className="text-ink-light" />
          </Link>
        </FlowStep>

        {/* 2 — Ask questions */}
        <FlowStep
          num={2}
          title="Ask the client any questions"
          blurb="Unclear transactions? Send a quick question — tracked in their email history."
        >
          <button
            type="button"
            onClick={() => setComposer("ask")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
          >
            <Mail size={13} /> Ask a question
          </button>
        </FlowStep>

        {/* 3 — Request documents */}
        <FlowStep
          num={3}
          title="Request any documents"
          blurb="Missing a statement or receipt? Ask for it now so the close isn't blocked."
        >
          <button
            type="button"
            onClick={() => setComposer("docs")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
          >
            <FileText size={13} /> Request documents
          </button>
        </FlowStep>

        {/* 4 — Close. Lands on THIS client's statements (Balance Sheet tab),
            not the fleet board — the bookkeeper reviews the numbers they're
            about to send before sending them. The board link stays as a
            secondary for the attest + send step itself. */}
        <FlowStep
          num={4}
          title="Verify & close the month"
          blurb="Review this client's statements, then run the reliability checks and send."
          last
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {onNavigateTab ? (
              <button
                type="button"
                onClick={() => onNavigateTab("bs")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-dark"
              >
                <CheckCircle2 size={13} /> Review the statements <ArrowRight size={12} />
              </button>
            ) : (
              <Link
                href="/production"
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-dark"
              >
                <CheckCircle2 size={13} /> Close the month <ArrowRight size={12} />
              </Link>
            )}
            <Link
              href="/production"
              title="The Production board — where the reliability checks, attestation and send happen"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
            >
              Close &amp; send on the board <ArrowRight size={12} className="text-ink-light" />
            </Link>
          </div>
        </FlowStep>
      </div>

      {/* Re-run a cleanup check — production clients still need to re-scan for
          revenue / expense double-counts when something looks off. The cleanup
          sequence itself is hidden once a client graduates, so surface the
          scanners here rather than send them hunting (Lisa, Supreme). */}
      <div className="rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <RotateCcw size={14} className="text-ink-slate" />
          <span className="text-xs font-bold uppercase tracking-wide text-ink-slate">
            Something look off? Re-run a cleanup check
          </span>
        </div>
        <p className="text-[11px] text-ink-slate mt-0.5">
          These scanners are read-only until you apply a fix — safe to re-run on a live client any time.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Link
            href={`/revenue-check/${clientLinkId}`}
            title="Deposits-as-revenue, CRM-invoice double-count, and payroll double-count"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
          >
            <Search size={13} /> Revenue &amp; payroll check <ArrowRight size={12} className="text-ink-light" />
          </Link>
          <Link
            href={`/admin/duplicates?client=${clientLinkId}`}
            title="Find & clear duplicate bills / expenses for this client"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy hover:border-teal"
          >
            <Search size={13} /> Duplicate expenses <ArrowRight size={12} className="text-ink-light" />
          </Link>
        </div>
      </div>

      {composer && (
        <AskClientComposer
          clientLinkId={clientLinkId}
          clientName={clientName}
          emailType={composer === "docs" ? "docs_request" : "ask_client"}
          defaultSubject={
            composer === "docs"
              ? `Documents needed to close your month — ${clientName}`
              : `Quick question closing your month — ${clientName}`
          }
          defaultIntro={
            composer === "docs"
              ? `Hi there,\n\nTo finish closing out this month we still need a couple of documents from you. Could you send over the following when you get a chance?\n\n• \n• `
              : undefined
          }
          onClose={() => setComposer(null)}
        />
      )}
    </div>
  );
}

function FlowStep({
  num,
  title,
  blurb,
  children,
  last,
}: {
  num: number;
  title: string;
  blurb: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`rounded-xl border border-gray-200 bg-white px-4 py-3 ${last ? "border-teal/40" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5 h-6 w-6 rounded-full bg-teal-light text-teal flex items-center justify-center text-[11px] font-bold">
          {num}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-navy">{title}</div>
          <p className="text-[11px] text-ink-slate mt-0.5">{blurb}</p>
          <div className="mt-2">{children}</div>
        </div>
      </div>
    </div>
  );
}
