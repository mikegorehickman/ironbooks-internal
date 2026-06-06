import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Home, FileText, Scale, Wallet, Receipt, MessageSquare,
  GraduationCap, Settings, FileCheck2,
} from "lucide-react";
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
            <NavLink href="/portal/profit-loss" icon={FileText} label="Profit & Loss" />
            <NavLink href="/portal/balance-sheet" icon={Scale} label="Balance Sheet" />
            <NavLink href="/portal/whos-paying" icon={Wallet} label="Who owes you" />
            <NavLink href="/portal/whats-due" icon={Receipt} label="What you owe" />
            <NavLink href="/portal/cleanup-reports" icon={FileCheck2} label="Cleanup Reports" />
            <NavLink href="/portal/ask-ai" icon={MessageSquare} label="Ask the AI" badge="NEW" />
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
  href, icon: Icon, label, badge,
}: {
  href: string; icon: any; label: string; badge?: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-white/75 hover:bg-white/5 hover:text-white"
    >
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="text-[9px] font-bold bg-teal text-white px-1.5 py-0.5 rounded">
          {badge}
        </span>
      )}
    </Link>
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
