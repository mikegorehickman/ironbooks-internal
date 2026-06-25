"use client";

import { useState } from "react";
import { Phone, Loader2, ExternalLink, Check } from "lucide-react";

export function CoachingCallBooking({
  coaches,
  enabled,
  fallbackLink,
  impersonating,
}: {
  coaches: { coach_key: string; coach_name: string }[];
  enabled: boolean;
  fallbackLink: string | null;
  impersonating: boolean;
}) {
  const [coachKey, setCoachKey] = useState<string>(coaches[0]?.coach_key || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function book() {
    if (!coachKey) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/coaching-calls/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coach_key: coachKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Could not start checkout");
      window.location.href = data.url;
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <div className="flex items-center gap-2 text-xs text-ink-slate uppercase tracking-wider font-semibold">
          <Phone size={13} /> Coaching
        </div>
        <h1 className="text-3xl font-bold text-navy mt-1">Book a coaching call</h1>
        <p className="text-sm text-ink-slate mt-2 leading-relaxed">
          A focused 30-minute 1:1 — <strong className="text-navy">$150</strong>. Bring your 2–3 biggest
          questions; your coach reviews your latest month beforehand so you leave with a clear action plan.
        </p>
      </div>

      {impersonating ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-ink-slate italic">
          Payment actions are hidden while impersonating.
        </div>
      ) : enabled ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
          <div>
            <div className="text-sm font-bold text-navy mb-2">Choose your coach</div>
            <div className="grid sm:grid-cols-2 gap-3">
              {coaches.map((c) => {
                const active = coachKey === c.coach_key;
                return (
                  <button
                    key={c.coach_key}
                    onClick={() => setCoachKey(c.coach_key)}
                    className={`text-left rounded-xl border-2 px-4 py-3 transition-colors ${
                      active ? "border-teal bg-teal-lighter" : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-navy">{c.coach_name}</span>
                      {active && <Check size={16} className="text-teal" />}
                    </div>
                    <div className="text-xs text-ink-slate mt-0.5">30 min · $150</div>
                  </button>
                );
              })}
            </div>
          </div>

          {err && <div className="text-sm text-red-600">{err}</div>}

          <div>
            <button
              onClick={book}
              disabled={busy || !coachKey}
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : null}
              {busy
                ? "Starting checkout…"
                : `Book ${coaches.find((c) => c.coach_key === coachKey)?.coach_name || ""} — $150`}
            </button>
            <p className="text-[11px] text-ink-light mt-2">
              Secure payment, then pick your time. Your saved card is used if we have one on file.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <p className="text-sm text-ink-slate mb-4">Ready to book? Grab a time below.</p>
          <a
            href={fallbackLink || "mailto:admin@ironbooks.com?subject=Book%20a%20coaching%20call"}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
          >
            {fallbackLink ? "Book & pay now" : "Request a session"} <ExternalLink size={13} />
          </a>
        </div>
      )}
    </div>
  );
}
