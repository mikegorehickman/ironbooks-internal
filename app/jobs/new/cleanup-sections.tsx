"use client";

import { useState } from "react";
import Link from "next/link";
import {
  MapPin, ArrowRight, ChevronDown, ChevronRight, RefreshCw, CreditCard, Scale, CheckCircle2,
  Send, Loader2, Clock,
} from "lucide-react";
import type { RosterClient } from "@/lib/cleanup-roster";

function sortRows(rows: RosterClient[]): RosterClient[] {
  return [...rows].sort((a, b) => {
    if (a.highlight !== b.highlight) return a.highlight ? -1 : 1;
    // Stripe: longest-waiting first.
    if (a.bucket === "stripe" && b.bucket === "stripe") {
      return (a.requestedAt || "").localeCompare(b.requestedAt || "");
    }
    return a.client_name.localeCompare(b.client_name);
  });
}

function waitingDays(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function Avatar({ c }: { c: RosterClient }) {
  return (
    <div
      className={`rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 ${
        c.highlight ? "bg-teal text-white" : "bg-teal-light text-teal"
      }`}
    >
      {c.client_name.charAt(0)}
    </div>
  );
}

/** Stripe rows: name links to the recon page; a Resend button sits alongside. */
function StripeRow({ c }: { c: RosterClient }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const days = waitingDays(c.requestedAt);

  async function resend(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/clients/${c.id}/send-stripe-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isReminder: true }),
      });
      const d = await res.json();
      if (!res.ok || d.no_address) throw new Error(d.error || (d.no_address ? "No email on file" : "Couldn't resend"));
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border-2 border-amber-100 bg-amber-50/40">
      <Avatar c={c} />
      <Link href={c.routeTarget || "#"} className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-navy truncate">{c.client_name}</div>
        <div className="text-xs flex items-center gap-1.5 text-amber-700">
          <Clock size={11} />
          {days === null ? "Waiting to connect" : `Waiting to connect · ${days} day${days === 1 ? "" : "s"}`}
        </div>
      </Link>
      <div className="flex items-center gap-2 flex-shrink-0">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        <button
          onClick={resend}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-md border border-teal-border bg-white text-teal-dark hover:bg-teal-light px-2.5 py-1.5 disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : done ? <CheckCircle2 size={12} /> : <Send size={12} />}
          {done ? "Re-sent" : "Resend email"}
        </button>
      </div>
    </div>
  );
}

function Row({ c }: { c: RosterClient }) {
  if (c.bucket === "stripe") return <StripeRow c={c} />;
  const inner = (
    <div
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border-2 transition-colors ${
        c.highlight
          ? "border-teal/40 bg-teal-lighter hover:bg-teal-light"
          : "border-gray-100 hover:bg-gray-50 hover:border-gray-200"
      }`}
    >
      <Avatar c={c} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-navy truncate">{c.client_name}</div>
        <div className="text-xs flex items-center gap-2 text-ink-slate">
          {c.highlight ? (
            <span className="font-semibold text-teal flex items-center gap-1"><CheckCircle2 size={11} /> {c.subLabel}</span>
          ) : (
            <>
              <MapPin size={11} /> {c.jurisdiction} {c.state_province && `· ${c.state_province}`}
              <span className="text-ink-light">·</span> {c.subLabel}
            </>
          )}
        </div>
      </div>
      <ArrowRight size={16} className="text-ink-light flex-shrink-0" />
    </div>
  );
  return c.routeTarget ? <Link href={c.routeTarget} className="block">{inner}</Link> : inner;
}

function Section({
  title, icon: Icon, rows, defaultCollapsed = false, emptyHint,
}: {
  title: string;
  icon: any;
  rows: RosterClient[];
  defaultCollapsed?: boolean;
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const sorted = sortRows(rows);
  return (
    <div className="rounded-xl bg-white border border-gray-200 mb-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3.5 border-b border-gray-100 flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-teal" />
          <h3 className="font-bold text-sm text-navy">{title}</h3>
          <span className="text-[11px] font-semibold text-ink-light bg-gray-100 rounded-full px-2 py-0.5">{rows.length}</span>
        </div>
        {open ? <ChevronDown size={16} className="text-ink-light" /> : <ChevronRight size={16} className="text-ink-light" />}
      </button>
      {open && (
        <div className="p-3 space-y-1.5">
          {sorted.length === 0 ? (
            <p className="text-xs text-ink-light py-3 text-center">{emptyHint || "Nothing here."}</p>
          ) : (
            sorted.map((c) => <Row key={c.id} c={c} />)
          )}
        </div>
      )}
    </div>
  );
}

export function CleanupSections({
  continueCleanup, completed, stripeRecon, bsCleanup,
}: {
  continueCleanup: RosterClient[];
  completed: RosterClient[];
  stripeRecon: RosterClient[];
  bsCleanup: RosterClient[];
}) {
  return (
    <div>
      <Section title="Continue cleanup" icon={RefreshCw} rows={continueCleanup} defaultCollapsed emptyHint="No cleanups in progress." />
      <Section title="Stripe recon — waiting to connect" icon={CreditCard} rows={stripeRecon} defaultCollapsed emptyHint="No pending Stripe connections." />
      <Section title="Balance Sheet cleanup" icon={Scale} rows={bsCleanup} defaultCollapsed emptyHint="No production clients awaiting BS." />
      <Section title="Open a completed cleanup" icon={CheckCircle2} rows={completed} defaultCollapsed emptyHint="No completed files." />
    </div>
  );
}
