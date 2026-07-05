"use client";

import Link from "next/link";
import { ShieldAlert, AlertTriangle, CalendarClock, Clock, Inbox, CheckCircle2 } from "lucide-react";
import { ViewAsSelector } from "./view-as-selector";
import type { TodayCounts } from "@/lib/today-priority";

/**
 * Pulse bar — the at-a-glance time-pressure summary that sits at the top of
 * /today. Five count chips answer "where's the pressure?" in one read; a 0
 * chip goes muted gray so an empty Blocked/Overdue reads instantly as
 * "good". Each chip jumps to the relevant section. Carries the month-end
 * status (a status, not an action) and the senior view-as selector.
 */

type Tone = "red" | "amber" | "teal";

function Chip({
  label,
  count,
  tone,
  href,
  Icon,
}: {
  label: string;
  count: number;
  tone: Tone;
  href: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
}) {
  const active = count > 0;
  const toneCls = !active
    ? "bg-gray-50 text-ink-light border-gray-100"
    : tone === "red"
    ? "bg-red-50 text-red-700 border-red-200"
    : tone === "amber"
    ? "bg-amber-50 text-amber-800 border-amber-200"
    : "bg-teal-light text-teal border-teal/30";
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${toneCls} ${
        active ? "hover:brightness-95" : ""
      }`}
      title={`${count} ${label.toLowerCase()}`}
    >
      <Icon size={13} className={active ? "" : "opacity-50"} />
      <span className="tabular-nums font-bold">{count}</span>
      <span className="hidden sm:inline opacity-80">{label}</span>
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
    <div className="bg-white border border-gray-200 rounded-2xl px-3 py-2.5 flex items-center gap-2 flex-wrap">
      <Chip label="Blocked" count={counts.blocked} tone="red" href="#clients" Icon={ShieldAlert} />
      <Chip label="Overdue" count={counts.overdue} tone="red" href="#work" Icon={AlertTriangle} />
      <Chip label="Due today" count={counts.dueToday} tone="amber" href="#work" Icon={CalendarClock} />
      <Chip label="Due soon" count={counts.dueSoon} tone="teal" href="#work" Icon={Clock} />
      <Chip label="Needs you" count={counts.needsYou} tone="amber" href="#work" Icon={Inbox} />

      <div className="flex-1 min-w-2" />

      {totalClients > 0 && (
        <Link
          href="/production"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-ink-slate hover:border-gray-300"
          title="Monthly close board"
        >
          <CheckCircle2 size={13} className="text-emerald-600" />
          <span className="tabular-nums">
            <span className="font-bold text-navy">{monthlyClosedCount}</span>/{totalClients}
          </span>
          <span className="hidden md:inline opacity-80">closed · {closingPeriodLabel}</span>
        </Link>
      )}

      {isSenior && <ViewAsSelector bookkeepers={bookkeepers} current={viewAs} />}
    </div>
  );
}
