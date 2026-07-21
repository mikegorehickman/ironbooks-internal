"use client";

import Link from "next/link";
import { useState } from "react";
import { Shuffle, Mail, FileText, CheckCircle2, ArrowRight } from "lucide-react";
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
}: {
  clientLinkId: string;
  clientName: string;
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

        {/* 4 — Close */}
        <FlowStep
          num={4}
          title="Verify & close the month"
          blurb="Run the reliability checks, review the statements, and send — on the Production board."
          last
        >
          <Link
            href="/production"
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-dark"
          >
            <CheckCircle2 size={13} /> Close the month <ArrowRight size={12} />
          </Link>
        </FlowStep>
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
