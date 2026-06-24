"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface Coach {
  coach_key: string;
  coach_name: string;
  ghl_embed_url: string;
  ghl_calendar_id: string;
  active: boolean;
}

export function CoachingCallsSettings({
  coaches: initial,
  priceUsdConfigured,
  priceCadConfigured,
}: {
  coaches: Coach[];
  priceUsdConfigured: boolean;
  priceCadConfigured: boolean;
}) {
  const [coaches, setCoaches] = useState<Coach[]>(initial);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [err, setErr] = useState("");

  function update(key: string, patch: Partial<Coach>) {
    setCoaches((cs) => cs.map((c) => (c.coach_key === key ? { ...c, ...patch } : c)));
  }

  async function save(coach: Coach) {
    setSavingKey(coach.coach_key);
    setErr("");
    try {
      const res = await fetch("/api/admin/coaching-calls", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(coach),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Save failed");
      setSavedKey(coach.coach_key);
      setTimeout(() => setSavedKey((k) => (k === coach.coach_key ? null : k)), 2500);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Pricing status (configured via Stripe + env) */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-bold text-navy mb-1">Pricing</h3>
        <p className="text-xs text-ink-slate mb-3">
          $150 / 30 min. The two Stripe products (USD + CAD) are referenced by env vars; SNAP picks the
          currency from each client&apos;s jurisdiction.
        </p>
        <div className="flex gap-3 text-xs">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold ${priceUsdConfigured ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
            {priceUsdConfigured ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />} USD price {priceUsdConfigured ? "configured" : "missing (STRIPE_COACHING_PRICE_USD)"}
          </span>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold ${priceCadConfigured ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
            {priceCadConfigured ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />} CAD price {priceCadConfigured ? "configured" : "missing (STRIPE_COACHING_PRICE_CAD)"}
          </span>
        </div>
      </div>

      {err && <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-sm text-red-800">{err}</div>}

      {coaches.map((coach) => (
        <div key={coach.coach_key} className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between">
            <input
              value={coach.coach_name}
              onChange={(e) => update(coach.coach_key, { coach_name: e.target.value })}
              className="text-base font-bold text-navy border-b border-transparent hover:border-gray-200 focus:border-teal outline-none"
            />
            <label className="flex items-center gap-2 text-xs font-semibold text-ink-slate cursor-pointer">
              <input
                type="checkbox"
                checked={coach.active}
                onChange={(e) => update(coach.coach_key, { active: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              Bookable
            </label>
          </div>

          <div>
            <label className="block text-xs font-semibold text-navy mb-1">GHL calendar embed URL</label>
            <p className="text-[11px] text-ink-light mb-1.5">
              From GHL → Calendar → Share → Embed (the iframe <code>src</code>). Shown to the client after they pay.
            </p>
            <input
              value={coach.ghl_embed_url}
              onChange={(e) => update(coach.coach_key, { ghl_embed_url: e.target.value })}
              placeholder="https://api.leadconnectorhq.com/widget/booking/…"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono outline-none focus:border-teal"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-navy mb-1">GHL calendar ID</label>
            <p className="text-[11px] text-ink-light mb-1.5">
              Used to match the booking webhook back to this coach (locks the one-time link).
            </p>
            <input
              value={coach.ghl_calendar_id}
              onChange={(e) => update(coach.coach_key, { ghl_calendar_id: e.target.value })}
              placeholder="calendar id"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono outline-none focus:border-teal"
            />
          </div>

          <button
            onClick={() => save(coach)}
            disabled={savingKey === coach.coach_key}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
          >
            {savingKey === coach.coach_key ? <Loader2 size={14} className="animate-spin" /> : savedKey === coach.coach_key ? <CheckCircle2 size={14} /> : null}
            {savedKey === coach.coach_key ? "Saved" : "Save"}
          </button>
        </div>
      ))}
    </div>
  );
}
