import Link from "next/link";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { ConnectButton } from "./connect-button";

export const dynamic = "force-dynamic";

/**
 * /connect-quickbooks — public landing page for QuickBooks Online connection.
 *
 * This URL is registered with Intuit as our official Connect / Reconnect
 * surface (required for production app approval). Users land here either:
 *   1. From Intuit's QBO App Store / "Get App Now" → first-time connect
 *   2. From a "reconnect" email link after a token died
 *   3. From the SNAP UI's "Connect QuickBooks" buttons
 *
 * Auth-aware:
 *   - Logged out → prompts sign-in, preserves intent via redirect param
 *   - Logged in as bookkeeper/admin/lead → can connect a NEW client realm OR
 *     reconnect an existing one (?client_link_id=<uuid>)
 *   - Logged in as client → connects/reconnects their OWN realm
 *
 * Designed to be safe for Intuit's review team to click through — no SNAP
 * jargon, clear "what happens next" copy, single CTA.
 */
export default async function ConnectQuickbooksPage({
  searchParams,
}: {
  searchParams?: Promise<{ client_link_id?: string; reason?: string }>;
}) {
  const sp = (await searchParams) || {};
  const reason = sp.reason || null;
  const targetClientLinkId = sp.client_link_id || null;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  // Resolve display role for copy variants. Service-role lookup so we
  // bypass RLS even for client-side sessions.
  let role: string | null = null;
  let displayName: string | null = null;
  if (user) {
    const service = createServiceSupabase();
    const { data: profile } = await service
      .from("users")
      .select("role, full_name")
      .eq("id", user.id)
      .single();
    role = (profile as any)?.role ?? null;
    displayName = (profile as any)?.full_name ?? user.email ?? null;
  }

  // Resolve target client for the connect/reconnect — when an internal user
  // is reconnecting a specific client, surface that name so they don't OAuth
  // the wrong realm by accident.
  let targetClientName: string | null = null;
  if (targetClientLinkId && targetClientLinkId !== "new" && role && role !== "client") {
    const service = createServiceSupabase();
    const { data: cl } = await service
      .from("client_links")
      .select("client_name")
      .eq("id", targetClientLinkId)
      .single();
    targetClientName = (cl as any)?.client_name ?? null;
  }

  // Construct the connect URL we'll hand to the button. The /api/qbo/connect
  // endpoint accepts an optional client_link_id (defaults to "new").
  const connectHref = targetClientLinkId
    ? `/api/qbo/connect?client_link_id=${encodeURIComponent(targetClientLinkId)}`
    : `/api/qbo/connect`;

  const loginHref = `/auth/login?next=${encodeURIComponent(
    `/connect-quickbooks${targetClientLinkId ? `?client_link_id=${targetClientLinkId}` : ""}`
  )}`;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
        {/* Header band */}
        <div className="bg-gradient-to-r from-[#2CA01C] to-[#1F7D14] px-8 py-7 text-white">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Ironbooks" className="w-10 h-10 rounded bg-white p-1" />
            <div className="text-xs uppercase tracking-widest opacity-80">Ironbooks SNAP</div>
          </div>
          <h1 className="mt-4 text-2xl font-bold leading-tight">
            Connect Ironbooks to QuickBooks Online
          </h1>
          <p className="mt-2 text-sm text-white/90 leading-relaxed">
            Securely link your QuickBooks Online company so Ironbooks can pull
            reports, clean up your books, and keep your data organized.
          </p>
        </div>

        <div className="px-8 py-7 space-y-6">
          {reason === "token_expired" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <strong>Reconnection needed.</strong> Your previous QuickBooks
              authorization has expired. Reconnect below to resume syncing —
              takes about 60 seconds.
            </div>
          )}

          {targetClientName && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <div className="text-slate-600 text-xs uppercase tracking-wider mb-1">
                Connecting client
              </div>
              <div className="font-semibold text-slate-900">{targetClientName}</div>
            </div>
          )}

          <div>
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-3">
              What happens when you click Connect
            </h2>
            <ol className="space-y-2.5 text-sm text-slate-700">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center">
                  1
                </span>
                <span>You'll be redirected to Intuit's secure sign-in page.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center">
                  2
                </span>
                <span>
                  Sign in to QuickBooks and choose which company to connect.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center">
                  3
                </span>
                <span>
                  Review the permissions Ironbooks is requesting and approve.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center">
                  4
                </span>
                <span>You'll be returned to Ironbooks. Done — no setup required.</span>
              </li>
            </ol>
          </div>

          {/* Auth-aware CTA */}
          {user ? (
            <div className="space-y-3">
              {displayName && (
                <div className="text-xs text-slate-500">
                  Signed in as <span className="font-medium text-slate-700">{displayName}</span>
                </div>
              )}
              <ConnectButton href={connectHref} />
            </div>
          ) : (
            <div className="space-y-3">
              <Link
                href={loginHref}
                className="block w-full text-center px-5 py-3 rounded-lg bg-[#2CA01C] hover:bg-[#1F7D14] text-white text-sm font-bold transition-colors shadow-sm"
              >
                Sign in to continue
              </Link>
              <p className="text-xs text-center text-slate-500">
                You'll need to sign in to Ironbooks first, then we'll bring you
                back here to connect QuickBooks.
              </p>
            </div>
          )}

          <div className="border-t border-slate-200 pt-5 space-y-2 text-xs text-slate-500">
            <p>
              <strong className="text-slate-700">Your data stays yours.</strong>{" "}
              Ironbooks only requests the QuickBooks permissions needed to
              produce your bookkeeping deliverables. You can disconnect at any
              time from QuickBooks → Apps → My Apps.
            </p>
            <p>
              Questions? Email{" "}
              <a href="mailto:support@ironbooks.com" className="text-blue-600 hover:underline">
                support@ironbooks.com
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
