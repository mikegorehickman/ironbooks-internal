"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowRight, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import type { DesyncedLogin } from "@/lib/client-email";

type Result = { client_name: string; to: string; from: string; ok: boolean; error: string | null };

export function ResyncLoginsClient({ initial }: { initial: DesyncedLogin[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!confirm(
      `Repoint ${initial.length} portal login${initial.length === 1 ? "" : "s"} to match each client's contact email?\n\n` +
      `Each affected client will sign in with their contact email going forward (their sign-in link goes to the new address).`
    )) return;
    setPhase("running"); setError(null);
    try {
      const res = await fetch("/api/admin/resync-client-logins", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Failed"); setPhase("idle"); return; }
      setResults(data.results || []);
      setPhase("done");
      router.refresh();
    } catch (e: any) {
      setError(e?.message || "Network error"); setPhase("idle");
    }
  }

  if (phase === "done") {
    const updated = results.filter((r) => r.ok).length;
    return (
      <div>
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 mb-4">
          <CheckCircle2 size={18} className="text-emerald-600" />
          <span className="text-sm font-semibold text-emerald-900">{updated} of {results.length} login{results.length === 1 ? "" : "s"} repointed.</span>
        </div>
        <ul className="space-y-2">
          {results.map((r, i) => (
            <li key={i} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <div className="text-sm font-semibold text-navy">{r.client_name}</div>
              <div className="text-xs text-ink-slate mt-0.5 flex items-center gap-1.5">
                <span className="line-through text-ink-light">{r.from}</span>
                <ArrowRight size={12} />
                <span className="text-navy">{r.to}</span>
              </div>
              {r.ok ? (
                <span className="text-[11px] text-emerald-700">✓ Login updated</span>
              ) : (
                <span className="text-[11px] text-amber-700 flex items-center gap-1"><AlertTriangle size={11} /> {r.error || "Not changed"}</span>
              )}
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-light mt-4">Verify any updated login in Supabase → Authentication → Users.</p>
      </div>
    );
  }

  if (initial.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-center">
        <CheckCircle2 size={22} className="text-emerald-500 mx-auto mb-2" />
        <p className="text-sm text-navy font-semibold">All client logins are in sync.</p>
        <p className="text-xs text-ink-slate mt-1">No portal logins differ from their contact email.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 mb-4 text-sm text-amber-900">
        <strong>{initial.length}</strong> client{initial.length === 1 ? "" : "s"} {initial.length === 1 ? "has" : "have"} a portal login that doesn't match their contact email. Repointing makes each client sign in with their contact email.
      </div>
      <ul className="space-y-2 mb-5">
        {initial.map((d) => (
          <li key={d.client_link_id} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="text-sm font-semibold text-navy">{d.client_name}</div>
            <div className="text-xs text-ink-slate mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-ink-light">login</span>
              <span className="line-through text-ink-light">{d.login_email}</span>
              <ArrowRight size={12} />
              <span className="text-navy font-medium">{d.contact_email}</span>
            </div>
          </li>
        ))}
      </ul>
      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
      <button
        onClick={run}
        disabled={phase === "running"}
        className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-lg"
      >
        {phase === "running" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        Re-sync {initial.length} login{initial.length === 1 ? "" : "s"} to contact email
      </button>
    </div>
  );
}
