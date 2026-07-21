"use client";

import Link from "next/link";
import { ViewAsSelector } from "./view-as-selector";
import type { TodayCounts } from "@/lib/today-priority";

/**
 * Metric strip — the at-a-glance time-pressure summary at the top of /today.
 * One card, hairline-divided columns (no sub-cards, per the design language):
 * label 11.5px caps muted, value 26px/800 tabular. A zero renders muted so an
 * empty Blocked/Overdue reads instantly as "good"; each cell jumps to its
 * section. Carries the month-end status and the senior view-as selector.
 */

function Cell({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string;
  tone: "rust" | "gold" | "navy" | "muted" | "teal";
  href: string;
}) {
  const color =
    tone === "rust" ? "text-rust"
    : tone === "gold" ? "text-gold-deep"
    : tone === "teal" ? "text-teal-dark"
    : tone === "muted" ? "text-ink-light"
    : "text-navy";
  return (
    <Link href={href} className="block px-5 py-4 hover:bg-[#FBFCFD] transition-colors">
      <div className="text-[11.5px] font-bold uppercase tracking-[0.12em] text-ink-light whitespace-nowrap">{label}</div>
      <div className={`text-[26px] font-extrabold leading-tight mt-1 ${color}`}>{value}</div>
    </Link>
  );
}

export function PulseBar({
  counts,
  isSenior,
  monthlyClosedCount,
  totalClients,
  closingPeriodLabel,
  bookkeepers,
  viewAs,
}: {
  counts: TodayCounts;
  isSenior: boolean;
  monthlyClosedCount: number;
  totalClients: number;
  closingPeriodLabel: string;
  bookkeepers: { id: string; full_name: string }[];
  viewAs: string | null;
}) {
  return (
    <div className="space-y-2">
      {isSenior && (
        <div className="flex justify-end">
          <ViewAsSelector bookkeepers={bookkeepers} current={viewAs} />
        </div>
      )}
      <div className="bg-white border border-cardline rounded-lg shadow-card grid grid-cols-3 md:grid-cols-6 divide-x divide-hairline overflow-x-auto">
        <Cell label="Blocked" value={String(counts.blocked)} tone={counts.blocked > 0 ? "rust" : "muted"} href="#clients" />
        <Cell label="Overdue" value={String(counts.overdue)} tone={counts.overdue > 0 ? "rust" : "muted"} href="#work" />
        <Cell label="Due today" value={String(counts.dueToday)} tone={counts.dueToday > 0 ? "gold" : "muted"} href="#work" />
        <Cell label="Due soon" value={String(counts.dueSoon)} tone={counts.dueSoon > 0 ? "navy" : "muted"} href="#work" />
        <Cell label="Needs you" value={String(counts.needsYou)} tone={counts.needsYou > 0 ? "gold" : "muted"} href="#work" />
        <Cell
          label={`Closed · ${closingPeriodLabel}`}
          value={totalClients > 0 ? `${monthlyClosedCount}/${totalClients}` : "—"}
          tone="navy"
          href="/production"
        />
      </div>
    </div>
  );
}
