"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

/** Map ?error= codes from the auth callback to user-friendly messages.
 *  Anything not in this map falls back to a generic. */
const ERROR_COPY: Record<string, string> = {
  not_authorized:
    "That email isn't authorized. Ironbooks team members: use your @ironbooks.com email. Clients: use the invite link from your email.",
  provision_failed:
    "Couldn't create your account. Please try again, or contact Mike if it keeps failing.",
  missing_code: "Sign-in link expired or invalid. Request a new one below.",
  oauth_failed: "Sign-in failed. Try requesting a new magic link.",
};

// Next.js 15 requires useSearchParams() to be inside a <Suspense> boundary
// during prerender, otherwise the page fails to build with a CSR-bailout
// error. Wrap the form in a Suspense + extract the searchParams-reading
// part into an inner component.
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Surface callback errors as a page-level message. The callback redirects
  // here with ?error=<code> and optionally ?email=<addr> when bouncing
  // unauthorized magic-link clickers.
  useEffect(() => {
    const code = searchParams?.get("error");
    if (code) {
      setError(ERROR_COPY[code] || `Sign-in failed (${code}).`);
    }
    const prefillEmail = searchParams?.get("email");
    if (prefillEmail) setEmail(prefillEmail);
  }, [searchParams]);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      setSent(true);
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-10 justify-center">
          <img
            src="/logo.png"
            alt="Ironbooks SNAP"
            className="w-12 h-12 object-contain"
          />
          <div className="font-bold text-2xl tracking-tight text-navy">Ironbooks SNAP</div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
          <h1 className="text-2xl font-bold text-navy mb-2 tracking-tight">Sign in</h1>
          <p className="text-sm text-ink-slate mb-6">
            We&apos;ll email you a magic link. No password required.
          </p>

          {sent ? (
            <div className="bg-teal-lighter border border-teal-light rounded-lg p-4">
              <p className="text-sm font-medium text-navy">
                ✓ Check your email at <strong>{email}</strong>
              </p>
              <p className="text-xs text-ink-slate mt-1">
                Click the link to sign in. Window can stay open.
              </p>
            </div>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-navy mb-1.5">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@ironbooks.com"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
                />
                <p className="text-[11px] text-ink-slate mt-1.5">
                  Ironbooks team: use your <strong>@ironbooks.com</strong> email — a bookkeeper account is created on first sign-in.
                </p>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-teal hover:bg-teal-dark text-white font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-50"
              >
                {loading ? "Sending..." : "Send magic link"}
              </button>
            </form>
          )}
        </div>

        <p className="text-xs text-center text-ink-slate mt-6">
          Internal tool for Ironbooks SNAP team members only.
        </p>
      </div>
    </main>
  );
}

/** Suspense fallback while useSearchParams() resolves. Renders a minimal
 *  visual placeholder so the page doesn't flash blank during prerender. */
function LoginShell() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-10 justify-center">
          <img
            src="/logo.png"
            alt="Ironbooks SNAP"
            className="w-12 h-12 object-contain"
          />
          <div className="font-bold text-2xl tracking-tight text-navy">Ironbooks SNAP</div>
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
          <h1 className="text-2xl font-bold text-navy mb-2 tracking-tight">Sign in</h1>
          <p className="text-sm text-ink-slate">Loading…</p>
        </div>
      </div>
    </main>
  );
}
