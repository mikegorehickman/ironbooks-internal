import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Home, Wallet, Receipt, MessageSquare,
  GraduationCap, Settings, FileCheck2, Mail, BookOpen, Tags,
} from "lucide-react";
import { MessagesNavLink } from "./messages-nav-link";
import { FinancialStatementsNav } from "./financial-statements-nav";
import { SignOutButton } from "./sign-out-button";
import { ImpersonationBanner } from "./impersonation-banner";
import { SupportWidget } from "./support-widget";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * Real client portal shell. Auth-gated via resolvePortalContext, which
 * also honors the admin impersonation cookie. When an admin/lead is
 * impersonating, the layout shows the orange "you are impersonating"
 * banner at the very top — unmissable.
 *
 * Differs from /portal-mockup/layout.tsx (the static design preview):
 *   - Real auth (middleware sends non-impersonating non-clients away;
 *     this layer re-resolves and renders the banner if applicable)
 *   - Real sign-out
 *   - Live "client_name" lookup
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // First confirm there's at least a session — bouncing here is friendlier
  // than letting tryResolvePortalContext throw a generic error.
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Pull the actual role so we can detect the "internal staff, NOT
  // impersonating" case — they shouldn't see the portal at all, kick to
  // /dashboard. Middleware already does this but the layout double-checks
  // because layouts get used outside the middleware path too (e.g. RSC).
  const service = createServiceSupabase();
  const { data: actorProfile } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const actorRole = (actorProfile as any)?.role;
  const isInternal = ["admin", "lead", "bookkeeper", "viewer"].includes(actorRole);

  const ctxResult = await tryResolvePortalContext();

  // QBO disconnected (token dead OR realm never set). Show a clear
  // reconnect UI for BOTH real clients and impersonating admins instead
  // of silently bouncing to /dashboard. The bounce previously hid the
  // real problem when admin clicked "View portal as client" for any
  // client whose refresh token had been revoked.
  if (!ctxResult.ok && ctxResult.code === "no_qbo") {
    return (
      <QboDisconnectedState
        clientLinkId={ctxResult.meta.clientLinkId || null}
        clientName={ctxResult.meta.clientName || "this client"}
        impersonating={!!ctxResult.meta.impersonating}
        realUserName={ctxResult.meta.realUserName || null}
        actorIsInternal={isInternal}
      />
    );
  }

  // Internal staff with no impersonation = wrong place
  if (isInternal && (!ctxResult.ok || !ctxResult.ctx.impersonating)) {
    redirect("/dashboard");
  }

  // Client with no mapping = friendly setup state
  if (!ctxResult.ok) {
    return (
      <NoClientMappingState fullName={(actorProfile as any)?.full_name || user.email || ""} />
    );
  }

  const { ctx } = ctxResult;
  const clientName = ctx.clientName;

  // Unread bookkeeper→client messages drive the red badge on the
  // Messages nav item — this is the client's notification spot.
  // try/catch so the portal keeps working if migration 58 hasn't
  // landed in this environment yet.
  let unreadMessages = 0;
  try {
    const { count } = await (service as any)
      .from("client_communications")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", ctx.clientLinkId)
      .eq("direction", "to_client")
      .is("read_at", null);
    unreadMessages = count || 0;
  } catch {
    unreadMessages = 0;
  }

  // Open ask-client questions drive the red badge on Categorize.
  // try/catch so the portal keeps working before migration 67 lands.
  let openCategorize = 0;
  try {
    const { data: jobs } = await (service as any)
      .from("reclass_jobs")
      .select("id")
      .eq("client_link_id", ctx.clientLinkId);
    const jobIds = ((jobs as any[]) || []).map((j) => j.id);
    if (jobIds.length > 0) {
      const { count } = await (service as any)
        .from("reclassifications")
        .select("id", { count: "exact", head: true })
        .in("reclass_job_id", jobIds)
        .eq("decision", "ask_client")
        .is("client_responded_at", null);
      openCategorize = count || 0;
    }
  } catch {
    openCategorize = 0;
  }

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {ctx.impersonating && (
        <ImpersonationBanner
          clientName={clientName}
          clientUserName={ctx.userFullName || ctx.userEmail || "this user"}
          realUserName={ctx.realUserName || "Admin"}
        />
      )}
      <div className="flex">
        <aside className="w-60 bg-[#0F1F2E] text-white min-h-screen flex flex-col">
          <div className="px-5 py-5 border-b border-white/10">
            <div className="font-bold text-base truncate" title={clientName}>
              {clientName}
            </div>
            <div className="text-xs text-white/50 mt-0.5">via Ironbooks</div>
          </div>

          <nav className="flex-1 px-2 py-3 space-y-0.5">
            <NavLink href="/portal" icon={Home} label="Overview" />
            <FinancialStatementsNav />
            <NavLink href="/portal/whos-paying" icon={Wallet} label="Who owes you" />
            <NavLink href="/portal/whats-due" icon={Receipt} label="What you owe" />
            <NavLink href="/portal/cleanup-reports" icon={FileCheck2} label="Cleanup Reports" />
            {/* Live: polls unread count, red pill + chime on new messages */}
            <MessagesNavLink initialCount={unreadMessages} />
            <NavLink
              href="/portal/categorize"
              icon={Tags}
              label="Categorize"
              badge={openCategorize > 0 ? String(openCategorize) : undefined}
              badgeTone="alert"
            />
            <NavLink href="/portal/ask-ai" icon={MessageSquare} label="Ask the AI" badge="NEW" />
            <NavLink href="/portal/knowledge-base" icon={BookOpen} label="Knowledge Base" />
            <NavLink href="/portal/learn" icon={GraduationCap} label="Learn" />
          </nav>

          <div className="px-3 py-3 border-t border-white/10 space-y-1">
            <Link
              href="/portal/settings"
              className="flex items-center gap-2 px-3 py-2 rounded text-sm text-white/65 hover:bg-white/5 hover:text-white"
            >
              <Settings size={14} /> Settings
            </Link>
            {/* Don't show client sign-out when impersonating — admin signs
                out via stop-impersonating + their own /auth/login flow */}
            {!ctx.impersonating && <SignOutButton />}
          </div>
        </aside>

        <main className="flex-1 max-w-5xl mx-auto px-8 py-8">{children}</main>
      </div>
      {/* Floating support chat — client-facing only. Mounted at layout
          level so it persists across every portal page navigation. */}
      <SupportWidget
        clientName={clientName}
        userEmail={ctx.userEmail}
        userFullName={ctx.userFullName}
      />
    </div>
  );
}

function NavLink({
  href, icon: Icon, label, badge, badgeTone = "accent",
}: {
  href: string; icon: any; label: string; badge?: string;
  /** accent = teal pill ("NEW"); alert = red unread-count pill */
  badgeTone?: "accent" | "alert";
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-white/75 hover:bg-white/5 hover:text-white"
    >
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      {badge && (
        <span
          className={`text-[9px] font-bold text-white px-1.5 py-0.5 rounded ${
            badgeTone === "alert" ? "bg-red-500 rounded-full min-w-[18px] text-center" : "bg-teal"
          }`}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

/**
 * Friendly recovery screen for the "QBO is disconnected" case. Replaces
 * the silent bounce-to-dashboard that admins used to hit when they tried
 * to impersonate a client whose refresh token had died (a category that
 * grew to 32 clients at once after the recent Intuit credential rotation).
 *
 * Real clients see the same screen with a "Reconnect QuickBooks" CTA;
 * admins see an additional "Stop impersonating" link so they're never
 * stuck inside a broken portal session.
 */
function QboDisconnectedState({
  clientLinkId,
  clientName,
  impersonating,
  realUserName,
  actorIsInternal,
}: {
  clientLinkId: string | null;
  clientName: string;
  impersonating: boolean;
  realUserName: string | null;
  actorIsInternal: boolean;
}) {
  const reconnectHref = clientLinkId
    ? `/connect-quickbooks?client_link_id=${encodeURIComponent(clientLinkId)}&reason=token_expired`
    : `/connect-quickbooks?reason=token_expired`;

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {impersonating && (
        <div className="bg-amber-500 text-white text-sm px-4 py-2.5 flex items-center justify-between">
          <div>
            <span className="font-bold">{realUserName || "Admin"}</span> viewing as{" "}
            <span className="font-bold">{clientName}</span>
          </div>
          <form action="/api/admin/impersonate/stop" method="POST">
            <button
              type="submit"
              className="text-xs font-bold underline underline-offset-2 hover:no-underline"
            >
              Stop impersonating
            </button>
          </form>
        </div>
      )}
      <div className="min-h-[calc(100vh-44px)] flex items-center justify-center px-4 py-12">
        <div className="max-w-lg w-full bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
          <div className="bg-gradient-to-r from-amber-500 to-amber-600 px-7 py-5 text-white">
            <div className="text-xs uppercase tracking-widest opacity-80">
              Action needed
            </div>
            <h1 className="mt-1 text-xl font-bold leading-tight">
              QuickBooks connection expired
            </h1>
          </div>
          <div className="px-7 py-6 space-y-5">
            <p className="text-sm text-slate-700 leading-relaxed">
              {impersonating ? (
                <>
                  <span className="font-semibold">{clientName}</span>'s QuickBooks
                  authorization has expired or been revoked. They (or you on
                  their behalf) need to reconnect QuickBooks before this portal
                  can load their books.
                </>
              ) : (
                <>
                  Your QuickBooks Online authorization has expired. Reconnect
                  below to resume access — takes about 60 seconds.
                </>
              )}
            </p>

            <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-600">
              <strong className="text-slate-800">Why this happened:</strong>{" "}
              QuickBooks refresh tokens expire after a period of inactivity, or
              when the connection is revoked from the QuickBooks Apps page.
              Re-authorizing restores access immediately.
            </div>

            <a
              href={reconnectHref}
              className="block w-full text-center px-5 py-3 rounded-lg bg-[#2CA01C] hover:bg-[#1F7D14] text-white text-sm font-bold transition-colors shadow-sm"
            >
              Reconnect QuickBooks
            </a>

            {actorIsInternal && impersonating && (
              <form action="/api/admin/impersonate/stop" method="POST">
                <button
                  type="submit"
                  className="block w-full text-center px-5 py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium transition-colors"
                >
                  Exit portal view
                </button>
              </form>
            )}

            <p className="text-xs text-slate-500 text-center pt-2">
              Questions? Email{" "}
              <a href="mailto:admin@ironbooks.com" className="text-blue-600 hover:underline">
                admin@ironbooks.com
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function NoClientMappingState({ fullName }: { fullName: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAF7] px-4">
      <div className="max-w-md text-center">
        <div className="text-2xl font-bold text-navy">Hi {fullName.split(" ")[0] || "there"} 👋</div>
        <p className="text-sm text-ink-slate mt-3">
          Your Ironbooks team is still finishing setting up your portal access.
          You should get an email when it's ready, usually within an hour.
        </p>
        <p className="text-xs text-ink-light mt-4">
          If this has been more than a day, reach out to your bookkeeper directly.
        </p>
      </div>
    </div>
  );
}
