"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

/** Map ?error= codes from the auth callback to user-friendly messages.
 *  Anything not in this map falls back to a generic. */
const ERROR_COPY: Record<string, string> = {
  not_authorized:
    "We don't recognize that email. Use the same email your Ironbooks invite was sent to, or contact us at admin@ironbooks.com. (Ironbooks team: use your @ironbooks.com email.)",
  provision_failed:
    "Couldn't create your account. Please try again, or email admin@ironbooks.com if it keeps failing.",
  missing_code: "Sign-in link expired or invalid. Request a new one below.",
  oauth_failed: "Sign-in failed. Try requesting a new magic link.",
  expired_invite:
    "Your activation link has expired or was already used. Enter your email below for a fresh sign-in link, or ask your bookkeeper to re-send your invite.",
};

/** Friendly message for when there's no portal account for the email yet.
 *  The portal is invite-only (Supabase signups are disabled), so requesting a
 *  link for an un-provisioned email returns "Signups not allowed for this
 *  instance" — which we translate into rollout-appropriate guidance. */
const NO_ACCOUNT_COPY =
  "We don't have a portal account for that email yet. Double-check you're using the exact email your Ironbooks invite was sent to — still stuck? Email admin@ironbooks.com and we'll get you set up right away.";

/** Translate a raw Supabase auth error into something a client can act on. */
function friendlyAuthError(message: string): string {
  const m = (message || "").toLowerCase();
  if (
    m.includes("signups not allowed") ||
    m.includes("signup is disabled") ||
    m.includes("signups are disabled") ||
    m.includes("user not found") ||
    m.includes("not found")
  ) {
    return NO_ACCOUNT_COPY;
  }
  if (m.includes("rate") || m.includes("too many") || m.includes("429")) {
    return "Too many sign-in attempts. Please wait a minute, then request a new link.";
  }
  return message || "Sign-in failed. Please try again.";
}

// Next.js 15 requires useSearchParams() to be inside a <Suspense> boundary
// during prerender, otherwise the page fails to build with a CSR-bailout
// error. Wrap the form in a Suspense + extract the searchParams-reading
// part into an inner component.
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginLayout><CardSkeleton /></LoginLayout>}>
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

    // Preserve a `next=` redirect through the magic-link flow so deep
    // links (e.g. /connect-quickbooks?client_link_id=...) land users back
    // on the page they came from after auth. /auth/callback honors this.
    const nextParam = searchParams?.get("next");
    const redirectTo = nextParam
      ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextParam)}`
      : `${window.location.origin}/auth/callback`;

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
      },
    });

    if (error) {
      // Invite-only portal: an un-provisioned client email returns
      // "Signups not allowed for this instance" — map that (and other raw
      // Supabase errors) to guidance the client can act on.
      setError(friendlyAuthError(error.message));
      setLoading(false);
    } else {
      setSent(true);
      setLoading(false);
    }
  }

  return (
    <LoginLayout>
      {/* Compact brand header for mobile (the full hero is desktop-only). */}
      <div className="lg:hidden mb-7 text-center">
        <div className="flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-navy">
            <img src="/logo.png" alt="" className="h-6 w-6 object-contain" />
          </span>
          <span className="text-lg font-bold tracking-tight text-navy">Ironbooks</span>
          <span className="rounded-full border border-navy/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-dark">
            Portal
          </span>
        </div>
        <h2 className="mt-5 text-2xl font-bold tracking-tight text-navy leading-tight">
          Advancing financial literacy in the trades.
        </h2>
        <p className="mt-2 text-sm text-ink-slate leading-relaxed">
          Live, plain-English books for painting &amp; trades businesses — so you
          always know exactly where you stand.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-white/60 p-8 shadow-xl shadow-navy/10">
        <div className="inline-flex items-center gap-2 rounded-full bg-teal-light px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal-dark mb-4">
          <span className="h-1.5 w-1.5 rounded-full bg-teal" />
          Client &amp; team sign-in
        </div>

        <h1 className="text-2xl font-bold text-navy tracking-tight">Welcome back</h1>
        <p className="text-sm text-ink-slate mt-2 mb-6 leading-relaxed">
          Sign in to see your books, reports, and messages. We&apos;ll email you a
          secure sign-in link — no password to remember.
        </p>

        {sent ? (
          <div className="rounded-xl bg-teal-lighter border border-teal-light p-5">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal text-white">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-4 w-4">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="text-sm font-semibold text-navy">Check your email</p>
            </div>
            <p className="text-sm text-ink-slate mt-2 leading-relaxed">
              We sent a secure sign-in link to <strong className="text-navy">{email}</strong>.
              Click it to sign in — you can leave this window open.
            </p>
            <button
              type="button"
              onClick={() => setSent(false)}
              className="text-xs font-medium text-teal-dark hover:underline mt-3"
            >
              Use a different email
            </button>
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
                placeholder="you@yourcompany.com"
                className="w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:border-teal focus:ring-2 focus:ring-teal/20 text-navy transition"
              />
              <p className="text-[11px] text-ink-slate mt-1.5">
                Use the email your Ironbooks invite was sent to.
              </p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 leading-relaxed">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-teal-lighter-dark hover:from-teal-dark hover:to-teal-dark text-white font-semibold py-3 rounded-xl transition-all disabled:opacity-50 shadow-sm shadow-teal/30"
            >
              {loading ? "Sending…" : "Send my sign-in link"}
            </button>
          </form>
        )}
      </div>

      {/* Can't-log-in / rollout help — also lives in the hero, repeated here
          for users on small screens who never see the hero panel. */}
      <div className="mt-5 rounded-2xl border border-navy/10 bg-white/70 backdrop-blur p-5 lg:hidden">
        <p className="text-sm font-semibold text-navy">New portal — just getting started</p>
        <p className="text-sm text-ink-slate mt-1.5 leading-relaxed">
          Can&apos;t sign in yet? Email{" "}
          <a href="mailto:admin@ironbooks.com" className="font-medium text-teal-dark hover:underline">
            admin@ironbooks.com
          </a>{" "}
          and we&apos;ll get you set up right away. You may hit the occasional bug
          during the rollout — thank you for your patience.
        </p>
      </div>

      <p className="text-xs text-center text-ink-slate mt-6">
        New to Ironbooks? Your bookkeeper will send you an invite email. Questions:{" "}
        <a href="mailto:admin@ironbooks.com" className="text-teal-dark font-medium hover:underline">
          admin@ironbooks.com
        </a>
      </p>
      <p className="text-[10px] text-center text-ink-light mt-2">
        Ironbooks team members sign in with their @ironbooks.com email.
      </p>
    </LoginLayout>
  );
}

/** Two-panel shell: branded mission hero on the left, sign-in on the right.
 *  Used by both the live page and the Suspense fallback so there's no flash. */
function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] bg-[#D4DCE8] font-sans">
      <BrandHero />
      <section className="relative flex items-center justify-center px-4 py-12 sm:px-8 lg:py-16">
        <div className="w-full max-w-md">{children}</div>
      </section>
    </main>
  );
}

/** Left-hand brand panel: the mission, value props, and the new-portal note. */
function BrandHero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-navy via-navy to-teal-dark text-white px-8 py-12 sm:px-12 lg:px-14 lg:py-16 hidden lg:flex flex-col justify-center">
      {/* decorative glows */}
      <div className="pointer-events-none absolute -top-28 -right-24 h-80 w-80 rounded-full bg-teal/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-20 h-72 w-72 rounded-full bg-teal/20 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgba(255,255,255,.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.6)_1px,transparent_1px)] [background-size:32px_32px]" />

      <div className="relative max-w-xl">
        {/* wordmark */}
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
            <img src="/logo.png" alt="" className="h-7 w-7 object-contain" />
          </span>
          <span className="text-xl font-bold tracking-tight">Ironbooks</span>
          <span className="ml-1 rounded-full border border-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-light">
            Portal
          </span>
        </div>

        {/* mission */}
        <p className="mt-10 text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-light/90">
          Our mission
        </p>
        <h2 className="mt-3 text-3xl sm:text-4xl font-bold leading-[1.12] tracking-tight">
          Advancing financial literacy
          <br className="hidden sm:block" /> in the trades.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-white/80">
          We give painting and trades businesses <strong className="text-white font-semibold">live,
          plain-English books</strong> — so you always know exactly where you stand and
          can make confident decisions about your money, your jobs, and your growth.
        </p>

        {/* value props */}
        <ul className="mt-8 space-y-4">
          {[
            {
              t: "Real-time financials.",
              d: "See your real numbers the moment they change — not months after the fact.",
            },
            {
              t: "Numbers that make sense.",
              d: "Clean reports and built-in AI that explain the “so what,” not just the totals.",
            },
            {
              t: "Built for the trades.",
              d: "Designed by a team that lives and breathes contracting businesses.",
            },
          ].map((f) => (
            <li key={f.t} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal/30 ring-1 ring-teal-light/40">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3.5 w-3.5 text-teal-light">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="text-sm leading-relaxed text-white/85">
                <strong className="font-semibold text-white">{f.t}</strong> {f.d}
              </p>
            </li>
          ))}
        </ul>

        {/* new portal / rollout note */}
        <div className="mt-10 rounded-2xl border border-white/15 bg-white/[0.06] p-5 backdrop-blur">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-teal-light" fill="currentColor">
              <path d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9z" />
            </svg>
            <p className="text-sm font-semibold text-white">Welcome to the new portal</p>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-white/80">
            This is our brand-new, <strong className="text-white font-semibold">in-house designed</strong>{" "}
            Ironbooks portal — rebuilt from the ground up for the way you actually run
            your business.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-white/80">
            Can&apos;t sign in yet? Email{" "}
            <a href="mailto:admin@ironbooks.com" className="font-semibold text-teal-light hover:text-white underline underline-offset-2">
              admin@ironbooks.com
            </a>{" "}
            and we&apos;ll get you set up ASAP. We&apos;re rolling this out now, so you may
            run into the occasional bug — thank you for your patience while we make it great.
          </p>
        </div>

        <p className="mt-10 text-[11px] text-white/40">
          © Ironbooks · Advancing Financial Literacy In The Trades
        </p>
      </div>
    </section>
  );
}

/** Suspense fallback for the sign-in card while useSearchParams() resolves. */
function CardSkeleton() {
  return (
    <div className="bg-white rounded-2xl border border-white/60 p-8 shadow-xl shadow-navy/10">
      <h1 className="text-2xl font-bold text-navy tracking-tight">Welcome back</h1>
      <p className="text-sm text-ink-slate mt-2">Loading…</p>
      <div className="mt-6 h-11 rounded-xl bg-gray-100 animate-pulse" />
      <div className="mt-4 h-11 rounded-xl bg-gray-100 animate-pulse" />
    </div>
  );
}
