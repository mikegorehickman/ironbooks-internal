"use client";

import { useState } from "react";
import { KeyRound, Loader2, Check, AlertTriangle } from "lucide-react";

/**
 * Header button on the client profile: re-send the portal login (magic) link to
 * the client's active portal user(s). Confirms the email + emails a fresh link,
 * for expired links or "I can't log in." (POST /api/clients/[id]/resend-portal-invite)
 */
export function ResendLoginLink({ clientLinkId }: { clientLinkId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function resend() {
    if (state === "sending") return;
    setState("sending");
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/resend-portal-invite`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setState("error");
        setMsg(json.error || (json.failed?.length ? `Couldn't send to ${json.failed.join(", ")}` : "Couldn't send"));
        return;
      }
      setState("sent");
      setMsg(`Sent to ${(json.sent || []).join(", ")}`);
    } catch (e: any) {
      setState("error");
      setMsg(e?.message || "Network error");
    }
  }

  return (
    <div className="relative">
      <button
        onClick={resend}
        disabled={state === "sending"}
        title="Email the client a fresh sign-in link (and confirm their account so they can log in)"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-ink-slate hover:text-navy hover:border-gray-300 disabled:opacity-50"
      >
        {state === "sending" ? <Loader2 size={13} className="animate-spin" />
          : state === "sent" ? <Check size={13} className="text-emerald-600" />
          : state === "error" ? <AlertTriangle size={13} className="text-red-600" />
          : <KeyRound size={13} />}
        {state === "sent" ? "Link sent" : "Re-send login link"}
      </button>
      {msg && (
        <div
          className={`absolute right-0 mt-1 z-10 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] ${
            state === "error"
              ? "bg-red-50 border-red-200 text-red-700"
              : "bg-emerald-50 border-emerald-200 text-emerald-800"
          }`}
        >
          {msg}
        </div>
      )}
    </div>
  );
}
