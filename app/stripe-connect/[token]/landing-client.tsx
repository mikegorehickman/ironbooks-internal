"use client";

import { useState } from "react";
import {
  Shield, Lock, Eye, AlertTriangle, CheckCircle2, XCircle, Clock, Loader2, ArrowRight,
} from "lucide-react";

type Validity =
  | { state: "valid"; clientName: string; expiresAt: string }
  | { state: "expired" }
  | { state: "used" }
  | { state: "not_found" };

export function LandingClient({
  validity,
  authorizeUrl,
  status,
  message,
}: {
  validity: Validity;
  authorizeUrl: string | null;
  status?: string;
  message?: string;
}) {
  const [redirecting, setRedirecting] = useState(false);

  // Success state — shown after OAuth callback redirects back with ?status=success
  if (status === "success") {
    return (
      <Shell>
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-green-100 flex items-center justify-center mb-4">
            <CheckCircle2 size={32} className="text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-navy mb-2">You're all connected</h1>
          <p className="text-sm text-ink-slate mb-6">
            Your Ironbooks bookkeeper can now match your Stripe deposits to invoices automatically.
            You can close this window.
          </p>
          <div className="rounded-lg bg-teal-lighter border border-teal/30 p-4 text-left">
            <div className="font-semibold text-sm text-teal mb-1 flex items-center gap-1.5">
              <Shield size={14} /> What we can see
            </div>
            <p className="text-xs text-ink-slate leading-relaxed">
              Read-only access to your payouts, charges, and balance transactions. We cannot move
              money, change settings, or issue refunds. You can revoke access anytime from your
              Stripe Dashboard → Settings → Connected applications.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  // Error states from the OAuth callback
  if (status === "denied" || status === "error" || status === "expired" || status === "already_used") {
    const meta = {
      denied:        { title: "Connection canceled",     hint: "You declined to authorize Ironbooks on Stripe. No data was shared. If this was a mistake, ask your bookkeeper for a fresh link." },
      error:         { title: "Something went wrong",    hint: message || "We hit an unexpected error completing the connection. Please ask your bookkeeper to send you a new link." },
      expired:       { title: "This link has expired",   hint: "Connect links are valid for 7 days. Ask your bookkeeper to send you a fresh one." },
      already_used:  { title: "This link is no longer valid", hint: "It looks like this link has already been used. If you need to reconnect, ask your bookkeeper for a fresh link." },
    } as const;
    const m = meta[status as keyof typeof meta];
    return (
      <Shell>
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-100 flex items-center justify-center mb-4">
            <XCircle size={32} className="text-red-600" />
          </div>
          <h1 className="text-2xl font-bold text-navy mb-2">{m.title}</h1>
          <p className="text-sm text-ink-slate">{m.hint}</p>
        </div>
      </Shell>
    );
  }

  // Token-level validity errors
  if (validity.state === "not_found") {
    return (
      <Shell>
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-amber-100 flex items-center justify-center mb-4">
            <AlertTriangle size={32} className="text-amber-600" />
          </div>
          <h1 className="text-2xl font-bold text-navy mb-2">Link not found</h1>
          <p className="text-sm text-ink-slate">
            This connect link is invalid or has been removed. Please ask your bookkeeper for a
            fresh link.
          </p>
        </div>
      </Shell>
    );
  }
  if (validity.state === "expired") {
    return (
      <Shell>
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-amber-100 flex items-center justify-center mb-4">
            <Clock size={32} className="text-amber-600" />
          </div>
          <h1 className="text-2xl font-bold text-navy mb-2">This link has expired</h1>
          <p className="text-sm text-ink-slate">
            Connect links are valid for 7 days. Ask your bookkeeper to send you a fresh one — it
            takes them about 30 seconds to generate.
          </p>
        </div>
      </Shell>
    );
  }
  if (validity.state === "used") {
    return (
      <Shell>
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-teal-light flex items-center justify-center mb-4">
            <CheckCircle2 size={32} className="text-teal" />
          </div>
          <h1 className="text-2xl font-bold text-navy mb-2">Already connected</h1>
          <p className="text-sm text-ink-slate">
            Looks like this Stripe connection has already been completed. You can safely close
            this window.
          </p>
        </div>
      </Shell>
    );
  }

  // Valid token — show the connection page
  function handleConnect() {
    if (!authorizeUrl) return;
    setRedirecting(true);
    window.location.href = authorizeUrl;
  }

  const expiresIn = (() => {
    const ms = new Date(validity.expiresAt).getTime() - Date.now();
    const days = Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
    return days;
  })();

  return (
    <Shell>
      {/* Headline */}
      <div className="text-center mb-7">
        <h1 className="text-2xl font-bold text-navy mb-2 tracking-tight">
          Connect Stripe for <span className="text-teal">{validity.clientName}</span>
        </h1>
        <p className="text-sm text-ink-slate leading-relaxed max-w-md mx-auto">
          Your Ironbooks bookkeeper is cleaning up your books and would like read-only access to
          your Stripe account so they can match deposits to customer invoices automatically. This
          takes 30 seconds.
        </p>
      </div>

      {/* What we can / can't do */}
      <div className="rounded-xl bg-teal-lighter border border-teal/30 p-5 mb-5">
        <div className="font-bold text-sm text-teal mb-3 flex items-center gap-1.5">
          <Shield size={15} /> What this gives Ironbooks
        </div>
        <div className="space-y-2.5 text-sm text-ink-slate">
          <div className="flex items-start gap-2">
            <Eye size={14} className="text-teal mt-0.5 flex-shrink-0" />
            <div>
              <span className="font-semibold text-navy">Read-only</span> — we can see your payouts,
              charges, and balance transactions to match them to your invoices in QuickBooks.
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Lock size={14} className="text-teal mt-0.5 flex-shrink-0" />
            <div>
              <span className="font-semibold text-navy">Never write access</span> — we can't move
              money, change settings, issue refunds, or charge your customers. The Stripe scope
              we request is literally called <code className="text-xs bg-white px-1 py-0.5 rounded">read_only</code>.
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle2 size={14} className="text-teal mt-0.5 flex-shrink-0" />
            <div>
              <span className="font-semibold text-navy">Revocable anytime</span> — in your Stripe
              Dashboard under Settings → Connected applications, you can remove Ironbooks with
              one click.
            </div>
          </div>
        </div>
      </div>

      {/* CTA */}
      {authorizeUrl ? (
        <button
          onClick={handleConnect}
          disabled={redirecting}
          className="w-full inline-flex items-center justify-center gap-2 bg-[#635BFF] hover:bg-[#5048d6] disabled:opacity-60 text-white font-semibold px-6 py-3.5 rounded-xl shadow-md transition-colors"
        >
          {redirecting ? (
            <>
              <Loader2 className="animate-spin" size={18} />
              Redirecting to Stripe...
            </>
          ) : (
            <>
              Connect with Stripe
              <ArrowRight size={18} />
            </>
          )}
        </button>
      ) : (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
          Stripe integration isn't fully configured yet. Please ask your bookkeeper to try again
          in a few minutes.
        </div>
      )}

      <p className="text-[11px] text-ink-light text-center mt-4">
        You'll be redirected to Stripe to approve. Link expires in {expiresIn} day{expiresIn === 1 ? "" : "s"}.
      </p>
    </Shell>
  );
}

// ─── Branded shell shared by all states ───

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background:
          "linear-gradient(135deg, #F4F9F8 0%, #FFFFFF 50%, #EFF6FF 100%)",
      }}
    >
      <div className="w-full max-w-lg">
        {/* Brand header */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <img
            src="/logo.png"
            alt="Ironbooks"
            className="w-12 h-12 object-contain"
          />
          <div>
            <div className="font-bold text-2xl tracking-tight text-navy leading-none">Ironbooks</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-ink-light mt-1">
              Bookkeeping · Cleanup
            </div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 p-8 shadow-lg">
          {children}
        </div>

        <p className="text-[11px] text-center text-ink-light mt-6">
          Powered by Ironbooks · Bookkeeper OS for trades businesses
        </p>
      </div>
    </main>
  );
}
