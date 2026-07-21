"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Check, ArrowRight } from "lucide-react";
import {
  PRIOR_YEAR_STATUS_META,
  type PriorYearStatus,
  type PriorYearTracking,
} from "@/lib/prior-year-cleanup";

const STATUS_OPTIONS: PriorYearStatus[] = [
  "flagged", "quoted", "notified", "approved", "in_progress", "done", "not_needed",
];

export function PriorYearRow({
  clientId,
  clientName,
  assigneeName,
  lastFiledYear,
  yearsNeeded,
  billableExtraYears,
  unknown,
  initialTracking,
}: {
  clientId: string;
  clientName: string;
  assigneeName: string | null;
  lastFiledYear: number | null;
  yearsNeeded: number[];
  billableExtraYears: number[];
  unknown: boolean;
  initialTracking: PriorYearTracking;
}) {
  const [tracking, setTracking] = useState<PriorYearTracking>(initialTracking);
  const [note, setNote] = useState(initialTracking.note || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function patch(payload: any) {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/prior-year-cleanup`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ years: yearsNeeded, ...payload }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Couldn't save");
      if (j.tracking) setTracking(j.tracking);
    } catch (e: any) {
      setErr(e?.message || "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  const meta = tracking.status ? PRIOR_YEAR_STATUS_META[tracking.status] : null;

  return (
    <tr className="border-t border-gray-100 hover:bg-gray-50/50 align-top">
      <td className="px-4 py-3">
        <Link href={`/clients/${clientId}`} className="font-semibold text-navy hover:text-teal">
          {clientName}
        </Link>
        <div className="text-[11px] text-ink-slate mt-0.5">{assigneeName || "Unassigned"}</div>
      </td>
      <td className="px-4 py-3 text-sm text-ink-slate whitespace-nowrap">
        {lastFiledYear ?? <span className="text-amber-700">Unknown</span>}
      </td>
      <td className="px-4 py-3">
        {unknown ? (
          <span className="text-xs text-amber-700">Capture last-filed year first</span>
        ) : yearsNeeded.length === 0 ? (
          <span className="text-xs text-emerald-700">Up to date</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {yearsNeeded.map((y) => (
              <span
                key={y}
                className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${
                  billableExtraYears.includes(y) ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
                }`}
                title={billableExtraYears.includes(y) ? "Extra billable year" : "Current catch-up year"}
              >
                {y}
              </span>
            ))}
            {billableExtraYears.length > 0 && (
              <span className="text-[11px] text-red-700 font-semibold">
                · {billableExtraYears.length} extra billable
              </span>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <select
            value={tracking.status || ""}
            onChange={(e) => patch({ status: e.target.value || undefined })}
            disabled={saving}
            className="text-xs font-semibold px-2 py-1 rounded border border-gray-200 bg-white text-navy outline-none"
          >
            <option value="">— set status —</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{PRIOR_YEAR_STATUS_META[s].label}</option>
            ))}
          </select>
          {meta && (
            <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${meta.cls}`}>
              {meta.label}
            </span>
          )}
        </div>
        {tracking.notified_at && (
          <div className="text-[11px] text-teal-dark mt-1">
            Client told {new Date(tracking.notified_at).toLocaleDateString()}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-start gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (tracking.note || "") && patch({ note })}
            placeholder="Note (quote, scope…)"
            className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 outline-none focus:border-teal text-navy"
          />
          {!tracking.notified_at && (
            <button
              type="button"
              onClick={() => patch({ markNotified: true })}
              disabled={saving}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-dark border border-teal-border rounded px-2 py-1 hover:bg-teal-light whitespace-nowrap disabled:opacity-50"
              title="Mark that the client has been told this is a billable catch-up"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Client notified
            </button>
          )}
          <Link
            href={`/clients/${clientId}?tab=cleanup`}
            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-teal hover:underline whitespace-nowrap"
          >
            Cleanup <ArrowRight size={11} />
          </Link>
        </div>
        {err && <div className="text-[11px] text-red-600 mt-1">{err}</div>}
      </td>
    </tr>
  );
}
