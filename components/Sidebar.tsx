"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles, Users, LogOut, BookOpen, Clock,
  Shield, CreditCard, ChevronDown, ChevronRight, Sun, TrendingUp,
  HeartPulse, Gauge, BadgeCheck,
  ClipboardCheck, ListChecks, UserPlus, GraduationCap, Settings as SettingsIcon, Inbox, ListTodo, LifeBuoy, ExternalLink, Landmark, Mail,
  Home as HomeIcon, Eye, FileText, CalendarClock,
  PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";
import type { Database } from "@/lib/database.types";
import { StripeConnectModal } from "./StripeConnectModal";

/** Daily work surface — the whole job, one flat list, no sub-menus.
 *  Client-scoped tools (Reclassify, Bank Rules, Stripe Recon, COA Editor,
 *  UF Audit, BS Wizard, GST/HST Audit) deliberately have NO nav entries:
 *  you start them from the client — cleanup-board card steps, the /clients
 *  row quick-actions, or the profile Cleanup tab — already scoped. */
// Re-IA nav shrink — four spines: Home / Clients / Oversight / Admin. Home
// absorbs Today + Inbox + Tasks; Oversight absorbs Approvals + Advisor + Fleet
// Health. Those six routes still work (the hubs render them), they're just off
// the nav now. Pipelines + Support stay in the daily set; the rest move to the
// collapsible Tools drawer.
const dailyNav: { href: string; label: string; icon: any; senior?: boolean; newTab?: boolean }[] = [
  { href: "/home", label: "Home", icon: HomeIcon },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/board", label: "Pipelines", icon: ClipboardCheck },
  { href: "/support", label: "Support", icon: LifeBuoy, newTab: true },
];

/** Oversight — the single senior hub (Approvals + Advisor + Fleet Health). */
const productionNav: { href: string; label: string; icon: any; senior?: boolean }[] = [
  { href: "/oversight", label: "Oversight", icon: Eye, senior: true },
];

/** Secondary fleet-wide views — collapsed under Tools. Anything client-scoped
 *  starts from the client workspace. */
const toolsNav = [
  { href: "/statements", label: "Statements", icon: FileText },
  { href: "/prior-year-cleanup", label: "Prior-Year Cleanup", icon: CalendarClock },
  { href: "/coa-audit", label: "COA Audit", icon: ListChecks },
  { href: "/history", label: "History", icon: Clock },
  { href: "/tax-exports", label: "Tax Exports", icon: Landmark },
  { href: "/templates", label: "Master COA", icon: BookOpen },
];

/** The /admin hub links onward to Billing, Call Matching, Daily Recon, and
 *  the Audit Log. Bulk Email gets its own row — used often enough on its
 *  own that a hub-then-hub-link round trip wasn't worth it. */
const adminItems = [
  { href: "/admin", label: "Admin", icon: Shield },
  { href: "/admin/bulk-email", label: "Bulk Email", icon: Mail },
  { href: "/admin/upgrades", label: "Upgrade Radar", icon: TrendingUp },
];

/** SNAP how-to handbook — pinned to the very bottom for the WHOLE internal
 *  team (admin, lead, bookkeeper). */
const handbookNav = { href: "/handbook", label: "Handbook", icon: GraduationCap };

export function Sidebar() {
  const pathname = usePathname();
  const [userName, setUserName] = useState<string>("");
  const [userRole, setUserRole] = useState<string>("");
  const [flaggedCount, setFlaggedCount] = useState(0);
  const [unreadComms, setUnreadComms] = useState(0);
  const [stripeModalOpen, setStripeModalOpen] = useState(false);
  // Collapsed = icon-only rail. Hydrated from localStorage AFTER mount (SSR
  // renders expanded; reading storage in the initializer would mismatch).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("snap.sidebar.collapsed") === "1") setCollapsed(true);
  }, []);
  function toggleCollapsed() {
    setCollapsed((v) => {
      localStorage.setItem("snap.sidebar.collapsed", v ? "0" : "1");
      return !v;
    });
  }

  // Tools always starts collapsed — even on a tools route — so the Work
  // section stays the visual default. The user can pop it open per page.
  const [toolsOpen, setToolsOpen] = useState(false);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) {
        const { data: profile } = await supabase
          .from("users")
          .select("full_name, role")
          .eq("id", data.user.id)
          .single();

        if (profile) {
          setUserName(profile.full_name);
          setUserRole(profile.role);

          supabase
            .from("users")
            .update({ last_login_at: new Date().toISOString() } as any)
            .eq("id", data.user.id)
            .then(() => {});

          if (profile.role === "admin" || profile.role === "lead") {
            const res = await fetch("/api/flagged/count");
            if (res.ok) {
              const { count } = await res.json();
              setFlaggedCount(count);
            }
          }
        }
      }
    });
  }, []);

  // Unread client messages — red badge on Today. Polls every 45s. (Audible
  // notifications were removed — see lib/sounds.ts kill switch.)
  useEffect(() => {
    let stopped = false;
    async function check() {
      try {
        const res = await fetch("/api/comms/unread-count");
        if (!res.ok || stopped) return;
        const { count } = await res.json();
        if (typeof count !== "number") return;
        setUnreadComms(count);
      } catch {
        /* transient — next poll retries */
      }
    }
    check();
    const id = setInterval(check, 45_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth/login";
  }

  const isAdmin = userRole === "admin";
  const isSenior = userRole === "admin" || userRole === "lead";
  const isBillingAdmin = userRole === "billing_admin";

  // Billing-only admin: a stripped sidebar with just Billing — no bookkeeping
  // nav (middleware also confines them to /admin/billing).
  if (isBillingAdmin) {
    return (
      <aside className="flex flex-col h-screen sticky top-0 w-[232px] bg-rail text-white">
        <div className="px-4 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Ironbooks" className="w-9 h-9 object-contain flex-shrink-0" />
            <div>
              <div className="font-bold text-base tracking-tight leading-none">Ironbooks</div>
              <div className="text-[11px] mt-0.5 text-white/45">Billing</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-2.5 py-3">
          <NavSection label="Billing" />
          <NavItem item={{ href: "/admin/billing", label: "Billing", icon: CreditCard }} pathname={pathname} />
          <NavItem item={{ href: "/admin/upgrades", label: "Upgrade Radar", icon: TrendingUp }} pathname={pathname} />
        </nav>
        <div className="px-2.5 py-3 border-t border-white/10">
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg bg-white/5">
            <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-8 h-8 bg-gold text-navy">{userName.charAt(0) || "?"}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold leading-tight truncate">{userName || "Loading..."}</div>
              <div className="text-[11px] leading-tight truncate text-white/45 capitalize">billing admin</div>
            </div>
            <button onClick={handleSignOut} className="text-white/40 hover:text-white transition-colors" title="Sign out"><LogOut size={15} /></button>
          </div>
        </div>
      </aside>
    );
  }

  const cleanupActive =
    pathname.startsWith("/jobs/") ||
    (pathname.startsWith("/reclass/") && /\/(reclass)\/[^/]+\//.test(pathname)) ||
    (pathname.startsWith("/stripe-recon/") && /\/(stripe-recon)\/[^/]+\//.test(pathname)) ||
    (pathname.startsWith("/rules/") && /\/(rules)\/[^/]+\//.test(pathname));

  return (
    <aside className={`flex flex-col h-screen sticky top-0 bg-rail text-white transition-[width] duration-150 ${collapsed ? "w-[64px]" : "w-[232px]"}`}>
      <div className={`py-4 border-b border-white/10 ${collapsed ? "px-2" : "px-4"}`}>
        <div className={`flex items-center ${collapsed ? "flex-col gap-2" : "gap-2.5"}`}>
          <img
            src="/logo.png"
            alt="Ironbooks SNAP"
            className="w-9 h-9 object-contain flex-shrink-0"
          />
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <div className="font-brand font-medium text-[15px] tracking-[0.14em] leading-none uppercase">Ironbooks</div>
              <div className="text-[10.5px] mt-1 tracking-[0.08em] uppercase text-[#7E99B3]">Bookkeeper OS</div>
            </div>
          )}
          <button
            onClick={toggleCollapsed}
            className="text-white/35 hover:text-white/80 transition-colors flex-shrink-0"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
      </div>

      <nav className="flex-1 px-2.5 py-3 overflow-y-auto">
        {/* No global "New Cleanup" button — cleanup always starts from a client
            (Pipelines → a client card's "Continue cleanup", or the client
            workspace Cleanup tab), never a picker-first flow. */}
        <NavSection label="Work" collapsed={collapsed} />
        {dailyNav
          .filter((item) => !item.senior || isSenior)
          .map((item) => (
            <NavItem
              key={item.href}
              item={item}
              pathname={pathname}
              badgeCount={item.href === "/home" ? unreadComms : undefined}
              badgeTone="red"
              collapsed={collapsed}
            />
          ))}

        {isSenior && (
          <>
            <NavSection label="Oversight" className="mt-3" collapsed={collapsed} />
            {productionNav
              .filter((item) => !item.senior || isSenior)
              .map((item) => (
                <NavItem
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  badgeCount={item.href === "/oversight" ? flaggedCount : undefined}
                  collapsed={collapsed}
                />
              ))}
          </>
        )}

        {isSenior && (
          <>
            <button
              onClick={() => setToolsOpen((v) => !v)}
              title="Tools"
              className={`w-full flex items-center gap-2 py-2 mt-3 text-[10px] font-bold uppercase tracking-wider text-white/35 hover:text-white/60 transition-colors ${collapsed ? "justify-center px-0" : "px-3"}`}
            >
              {toolsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {!collapsed && "Tools"}
            </button>
            {toolsOpen && (
              <div className="space-y-0.5">
                {toolsNav.map((item) => (
                  <NavItem key={item.href} item={item} pathname={pathname} dim collapsed={collapsed} />
                ))}
                <button
                  onClick={() => setStripeModalOpen(true)}
                  title="Stripe connect link"
                  className={`w-full flex items-center rounded-lg text-[13px] font-medium text-white/40 hover:bg-white/5 hover:text-white/70 transition-all mb-0.5 ${collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-3 py-1.5"}`}
                >
                  <CreditCard size={14} />
                  {!collapsed && "Stripe connect link"}
                </button>
              </div>
            )}
          </>
        )}

        {isAdmin && (
          <>
            <NavSection label="Admin" className="mt-4" collapsed={collapsed} />
            {adminItems.map((item) => (
              <NavItem key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
            ))}
          </>
        )}

        {/* Handbook — whole team, pinned to the very bottom of the nav. */}
        <div className="mt-4 pt-3 border-t border-white/10">
          <NavItem item={handbookNav} pathname={pathname} collapsed={collapsed} />
        </div>
      </nav>

      <div className="px-2.5 py-3 border-t border-white/10">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2.5 py-1">
            <div className="rounded-full flex items-center justify-center font-bold text-sm w-8 h-8 bg-gold text-navy" title={`${userName} · ${userRole}`}>
              {userName.charAt(0) || "?"}
            </div>
            <Link href="/settings" className="text-white/40 hover:text-white transition-colors" title="Settings · email signature">
              <SettingsIcon size={15} />
            </Link>
            <button onClick={handleSignOut} className="text-white/40 hover:text-white transition-colors" title="Sign out">
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg bg-white/5">
            <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-8 h-8 bg-gold text-navy">
              {userName.charAt(0) || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold leading-tight truncate">
                {userName || "Loading..."}
              </div>
              <div className="text-[11px] leading-tight truncate text-white/45 capitalize">
                {userRole}
              </div>
            </div>
            <Link href="/settings" className="text-white/40 hover:text-white transition-colors" title="Settings · email signature">
              <SettingsIcon size={15} />
            </Link>
            <button onClick={handleSignOut} className="text-white/40 hover:text-white transition-colors">
              <LogOut size={15} />
            </button>
          </div>
        )}
      </div>
      {stripeModalOpen && <StripeConnectModal onClose={() => setStripeModalOpen(false)} />}
    </aside>
  );
}

function NavSection({ label, className = "", collapsed }: { label: string; className?: string; collapsed?: boolean }) {
  // Collapsed rail: section labels become thin dividers.
  if (collapsed) return <div className={`my-2 mx-2 border-t border-white/10 ${className}`} />;
  return (
    <div className={`mb-1.5 px-3 text-[10.5px] font-bold uppercase tracking-wider text-[#8FA9C2] ${className}`}>
      {label}
    </div>
  );
}

function NavItem({
  item,
  pathname,
  badgeCount,
  badgeTone = "amber",
  dim,
  collapsed,
}: {
  item: { href: string; label: string; icon: any; newTab?: boolean };
  pathname: string;
  badgeCount?: number;
  badgeTone?: "amber" | "red";
  dim?: boolean;
  collapsed?: boolean;
}) {
  // newTab items (e.g. Support → Freshdesk) open externally, so they never
  // match the current path and never show as active.
  const active = !item.newTab && (pathname === item.href || pathname.startsWith(item.href + "/"));
  const Icon = item.icon;

  const className = `relative w-full flex items-center rounded-lg text-sm font-medium transition-all mb-0.5 ${
    collapsed ? "justify-center px-0 py-2.5" : "gap-2.5 px-3 py-2"
  } ${
    active
      ? "bg-white/[0.12] text-white font-semibold"
      : dim
      ? "text-white/40 hover:bg-white/5 hover:text-white/75"
      : "text-[#B9CBDC] hover:bg-white/5 hover:text-white"
  }`;

  const inner = collapsed ? (
    <>
      <Icon size={dim ? 15 : 17} className="flex-shrink-0" />
      {badgeCount != null && badgeCount > 0 && (
        <span
          className={`absolute top-1 right-1.5 w-2 h-2 rounded-full ${
            badgeTone === "red" ? "bg-rust" : "bg-gold text-navy"
          }`}
        />
      )}
    </>
  ) : (
    <>
      <Icon size={dim ? 14 : 16} className="flex-shrink-0" />
      <span className="text-[13px]">{item.label}</span>
      {item.newTab && <ExternalLink size={12} className="ml-auto flex-shrink-0 opacity-50" />}
      {badgeCount != null && badgeCount > 0 && (
        <span
          className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white tabular-nums ${
            badgeTone === "red" ? "bg-rust" : "bg-gold text-navy"
          }`}
        >
          {badgeCount > 999 ? "999+" : badgeCount}
        </span>
      )}
    </>
  );

  // Open externally in a new tab (full navigation, not SPA routing).
  if (item.newTab) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={className} title={collapsed ? item.label : undefined}>
        {inner}
      </a>
    );
  }

  return (
    <Link href={item.href} className={className} title={collapsed ? item.label : undefined}>
      {inner}
    </Link>
  );
}
