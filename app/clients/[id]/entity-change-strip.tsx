"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X as XIcon, AlertTriangle } from "lucide-react";
import {
  type EntityType, entityOptionsFor, entityLabel, resolveEntityType, taxFormFor,
} from "@/lib/entity-type";

/**
 * Low-priority entity-type control — lives at the very bottom of the client
 * Overview, deliberately out of the way. Changing a client's tax entity re-maps
 * the chart of accounts (owner-equity codes), changes which return the year-end
 * export targets, and shifts historical reports — so it's gated behind an
 * explicit confirm modal (Mike 2026-07-21: "require a second pop-up approval")
 * and only exposed to admin/lead.
 */
export function EntityChangeStrip({
  clientLinkId,
  jurisdiction,
  stateProvince,
  entityType,
  corporateType,
  canEdit,
}: {
  clientLinkId: string;
  jurisdiction?: string | null;
  stateProvince?: string | null;
  entityType: string | null;
  corporateType: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const options = entityOptionsFor(jurisdiction);
  const current = resolveEntityType(entityType, corporateType);
  const explicit = entityType && ["c_corp", "s_corp", "partnership", "sole_prop"].includes(entityType);
  const form = taxFormFor(current, jurisdiction);
  const isCA = String(jurisdiction || "").toUpperCase().startsWith("CA");
  const region = [isCA ? "CA" : "US", stateProvince].filter(Boolean).join(" · ");

  async function setType(value: EntityType) {
    setSaving(value);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: value }),
      });
      if (res.ok) {
        setSwitcherOpen(false);
        router.refresh();
      }
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/40 px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap text-[13px] text-ink-slate">
        <span>
          Entity type:{" "}
          <strong className="text-navy">
            {entityLabel(current, jurisdiction)}
            {region ? ` (${region})` : ""}
          </strong>
          {!explicit && <span className="text-gold-deep"> · assumed from onboarding</span>}
          {" "}— changing it re-maps the chart of accounts and tax docs (files <strong className="text-navy">{form}</strong>).
        </span>
        {canEdit ? (
          <button
            onClick={() => setConfirming(true)}
            className="text-xs font-semibold text-teal hover:text-teal-dark underline decoration-dotted underline-offset-2"
          >
            Change entity type…
          </button>
        ) : (
          <span className="text-[11px] text-ink-light">Only admin/lead can change this.</span>
        )}
      </div>

      {/* Switcher — only after confirm. */}
      {switcherOpen && canEdit && (
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink-light">Set to</span>
          {options.map((opt) => {
            const active = explicit ? entityType === opt : current === opt;
            return (
              <button
                key={opt}
                onClick={() => !active && setType(opt)}
                disabled={saving !== null}
                className={`px-3 py-1 rounded-full text-[11px] font-bold border transition-colors ${
                  active
                    ? "bg-teal text-white border-teal"
                    : "bg-white text-ink-slate border-gray-200 hover:border-teal/50 hover:text-teal"
                }`}
              >
                {saving === opt ? <Loader2 size={11} className="inline animate-spin" /> : entityLabel(opt, jurisdiction)}
              </button>
            );
          })}
          <button onClick={() => setSwitcherOpen(false)} className="text-[11px] text-ink-light hover:text-navy ml-1">
            Cancel
          </button>
        </div>
      )}

      {/* Confirm modal — the second approval. */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(11,29,46,0.32)" }}
          onClick={() => setConfirming(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <AlertTriangle size={16} className="text-[#954E44]" />
              <h3 className="text-sm font-bold text-navy">Change entity type?</h3>
              <button
                onClick={() => setConfirming(false)}
                className="ml-auto text-ink-light hover:text-navy"
                aria-label="Cancel"
              >
                <XIcon size={16} />
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-ink-slate space-y-2">
              <p>Changing this client's tax entity will:</p>
              <ul className="list-disc pl-5 space-y-1 text-[13px]">
                <li>Re-map the chart of accounts (owner-equity accounts).</li>
                <li>Change the tax documents the year-end export generates.</li>
                <li>Affect how historical reports are classified.</li>
              </ul>
              <p className="text-[13px]">This is logged. Only do it if you're sure of the client's classification.</p>
            </div>
            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="text-sm font-semibold px-3 py-2 rounded-lg border border-gray-200 text-ink-slate hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirming(false);
                  setSwitcherOpen(true);
                }}
                className="text-sm font-bold px-4 py-2 rounded-lg bg-[#954E44] text-white hover:opacity-90"
              >
                Yes, continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
