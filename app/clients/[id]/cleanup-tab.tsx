"use client";

import Link from "next/link";
import { ClipboardCheck, Shuffle, Zap, KanbanSquare, CreditCard, Wallet, Scale, ArrowRight } from "lucide-react";

/**
 * Client-profile "Cleanup" tab (SNAP V2) — the single place to launch any
 * cleanup engine for THIS client, in context (each link pre-scopes the client
 * so the New-job forms skip the picker and the redo-warning runs). Live step
 * state + the manager sign-off stay on the Workflow board.
 */
const ENGINES: {
  label: string;
  desc: string;
  icon: any;
  href: (id: string) => string;
}[] = [
  { label: "COA Cleanup", desc: "Rename / merge / inactivate accounts", icon: ClipboardCheck, href: (id) => `/jobs/new?client=${id}` },
  { label: "Reclassify", desc: "Re-map posted transactions", icon: Shuffle, href: (id) => `/reclass/new?client=${id}` },
  { label: "Bank Rules", desc: "Auto-categorization rules", icon: Zap, href: (id) => `/rules/new?client=${id}` },
  { label: "Balance Sheet Cleanup", desc: "Reconcile bank / CC / loan + A/R", icon: KanbanSquare, href: (id) => `/balance-sheet/${id}/cleanup` },
  { label: "Stripe Reconciliation", desc: "Match Stripe payouts to QBO", icon: CreditCard, href: (id) => `/stripe-recon/new?client=${id}` },
  { label: "UF Audit", desc: "Clear stuck Undeposited Funds — duplicates, CRM double-counts", icon: Wallet, href: (id) => `/balance-sheet/${id}/uf-audit` },
  { label: "UF / A/R Reconciler", desc: "One button: match deposits to revenue, true A/R, step-by-step clearing plan", icon: Scale, href: (id) => `/balance-sheet/${id}/ufar-recon` },
];

export function CleanupTab({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-slate">
        Launch any cleanup engine for <strong className="text-navy">{clientName}</strong> in
        context. Live step status and the manager sign-off live on the{" "}
        <Link href="/cleanup" className="text-teal font-semibold hover:underline">
          Cleanup board
        </Link>
        .
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {ENGINES.map((e) => {
          const Icon = e.icon;
          return (
            <Link
              key={e.label}
              href={e.href(clientLinkId)}
              className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 hover:border-teal transition-colors"
            >
              <div className="p-2 rounded-lg bg-teal-light text-teal">
                <Icon size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-navy">{e.label}</div>
                <div className="text-[11px] text-ink-slate">{e.desc}</div>
              </div>
              <ArrowRight size={14} className="text-ink-light" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
