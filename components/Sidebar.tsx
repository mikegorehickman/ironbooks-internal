"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles, Users, LogOut, BookOpen, Clock,
  Shield, CreditCard, ChevronDown, ChevronRight, Sun, TrendingUp,
  Volume2, VolumeX, HeartPulse, Gauge, BadgeCheck,
  ClipboardCheck, ListChecks, UserPlus, GraduationCap, Settings as SettingsIcon, Inbox, ListTodo, LifeBuoy, ExternalLink,
} from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";
import type { Database } from "@/lib/database.types";
import { StripeConnectModal } from "./StripeConnectModal";
import { isMuted, setMuted, onMutedChange, playSound } from "@/lib/sounds";

/** Daily work surface — the whole job, one flat list, no sub-menus.
 *  Client-scoped tools (Reclassify, Bank Rules, Stripe Recon, COA Editor,
 *  UF Audit, BS Wizard, GST/HST Audit) deliberately have NO nav entries:
 *  you start them from the client — cleanup-board card steps, the /clients
 *  row quick-actions, or the profile Cleanup tab — already scoped. */
const dailyNav: { href: string; label: string; icon: any; senior?: boolean; newTab?: boolean }[] = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/support", label: "Support", icon: LifeBuoy, newTab: true },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/onboarding", label: "Onboarding", icon: UserPlus, senior: true },
  { href: "/cleanup", label: "Cleanup", icon: ClipboardCheck },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/history", label: "History", icon: Clock },
];

/** Production — the board and the senior approval queue (statements,
 *  files, escalations, flagged transactions — one queue). The daily-recon
 *  engine controls live on the /admin hub. */
const productionNav: { href: string; label: string; icon: any; senior?: boolean }[] = [
  { href: "/production", label: "Production board", icon: ListChecks },
  { href: "/approvals", label: "Approvals", icon: BadgeCheck, senior: true },
];

/** Fleet-wide views only — anything client-scoped starts from the client. */
const toolsNav = [
  { href: "/fleet", label: "Fleet Health", icon: Gauge },
  { href: "/tax-exports", label: "Tax Exports", icon: Landmark },
  { href: "/advisor", label: "Advisor", icon: HeartPulse },
  { href: "/templates", label: "Master COA", icon: BookOpen },
];

/** One row: the /admin hub links onward to Billing, Bulk Email, Call
 *  Matching, Daily Recon, and the Audit Log. */
const adminItems = [
  { href: "/admin", label: "Admin", icon: Shield },
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

  // Unread client messages — red badge on Today + a chime when a NEW one
  // lands while the app is open. Polls every 45s; prev=null skips the
  // initial load so a pre-existing backlog doesn't ding on every refresh.
  useEffect(() => {
    let prev: number | null = null;
    let stopped = false;
    async function check() {
      try {
        const res = await fetch("/api/comms/unread-count");
        if (!res.ok || stopped) return;
        const { count } = await res.json();
        if (typeof count !== "number") return;
        if (prev !== null && count > prev) playSound("message_received");
        prev = count;
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
      <aside className="flex flex-col h-screen sticky top-0 w-56 bg-navy text-white">
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
            <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-8 h-8 bg-teal">{userName.charAt(0) || "?"}</div>
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
    <aside className="flex flex-col h-screen sticky top-0 w-56 bg-navy text-white">
      <div className="px-4 py-4 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <img
            src="/logo.png"
            alt="Ironbooks SNAP"
            className="w-9 h-9 object-contain flex-shrink-0"
          />
          <div>
            <div className="font-bold text-base tracking-tight leading-none">Ironbooks</div>
            <div className="text-[11px] mt-0.5 text-white/45">Bookkeeper OS</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-2.5 py-3 overflow-y-auto">
        <Link
          href="/jobs/new"
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all mb-4 ${
            cleanupActive
              ? "bg-teal text-white shadow-sm"
              : "bg-teal hover:bg-teal-dark text-white"
          }`}
        >
          <Sparkles size={16} />
          <span>New Cleanup</span>
        </Link>

        <NavSection label="Work" />
        {dailyNav
          .filter((item) => !item.senior || isSenior)
          .map((item) => (
            <NavItem
              key={item.href}
              item={item}
              pathname={pathname}
              badgeCount={item.href === "/today" ? unreadComms : undefined}
              badgeTone="red"
            />
          ))}

        <NavSection label="Production" className="mt-3" />
        {productionNav
          .filter((item) => !item.senior || isSenior)
          .map((item) => (
            <NavItem
              key={item.href}
              item={item}
              pathname={pathname}
              badgeCount={item.href === "/approvals" ? flaggedCount : undefined}
            />
          ))}

        {isSenior && (
          <>
            <button
              onClick={() => setToolsOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 mt-3 text-[10px] font-bold uppercase tracking-wider text-white/35 hover:text-white/60 transition-colors"
            >
              {toolsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Tools
            </button>
            {toolsOpen && (
              <div className="space-y-0.5">
                {toolsNav.map((item) => (
                  <NavItem key={item.href} item={item} pathname={pathname} dim />
                ))}
                <button
                  onClick={() => setStripeModalOpen(true)}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white/40 hover:bg-white/5 hover:text-white/70 transition-all mb-0.5"
                >
                  <CreditCard size={14} />
                  Stripe connect link
                </button>
              </div>
            )}
          </>
        )}

        {isAdmin && (
          <>
            <NavSection label="Admin" className="mt-4" />
            {adminItems.map((item) => (
              <NavItem key={item.href} item={item} pathname={pathname} />
            ))}
          </>
        )}

        {/* Handbook — whole team, pinned to the very bottom of the nav. */}
        <div className="mt-4 pt-3 border-t border-white/10">
          <NavItem item={handbookNav} pathname={pathname} />
        </div>
      </nav>

      <div className="px-2.5 py-3 border-t border-white/10">
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg bg-white/5">
          <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-8 h-8 bg-teal">
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
          <SoundToggle />
          <Link href="/settings" className="text-white/40 hover:text-white transition-colors" title="Settings · email signature">
            <SettingsIcon size={15} />
          </Link>
          <button onClick={handleSignOut} className="text-white/40 hover:text-white transition-colors">
            <LogOut size={15} />
          </button>
        </div>
      </div>
      {stripeModalOpen && <StripeConnectModal onClose={() => setStripeModalOpen(false)} />}
    </aside>
  );
}

function NavSection({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`mb-1.5 px-3 text-[10px] font-bold uppercase tracking-wider text-white/30 ${className}`}>
      {label}
    </div>
  );
}

function SoundToggle() {
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    setMutedState(isMuted());
    const off = onMutedChange(setMutedState);
    return off;
  }, []);

  return (
    <button
      onClick={() => setMuted(!muted)}
      className="text-white/40 hover:text-white transition-colors"
      title={muted ? "Sounds muted — click to unmute" : "Sounds on — click to mute"}
      aria-label={muted ? "Unmute sounds" : "Mute sounds"}
    >
      {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
    </button>
  );
}

function NavItem({
  item,
  pathname,
  badgeCount,
  badgeTone = "amber",
  dim,
}: {
  item: { href: string; label: string; icon: any; newTab?: boolean };
  pathname: string;
  badgeCount?: number;
  badgeTone?: "amber" | "red";
  dim?: boolean;
}) {
  // newTab items (e.g. Support → Freshdesk) open externally, so they never
  // match the current path and never show as active.
  const active = !item.newTab && (pathname === item.href || pathname.startsWith(item.href + "/"));
  const Icon = item.icon;

  const className = `w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all mb-0.5 ${
    active
      ? "bg-teal/20 text-white"
      : dim
      ? "text-white/40 hover:bg-white/5 hover:text-white/75"
      : "text-white/70 hover:bg-white/5 hover:text-white"
  }`;

  const inner = (
    <>
      <Icon size={dim ? 14 : 16} className="flex-shrink-0" />
      <span className="text-[13px]">{item.label}</span>
      {item.newTab && <ExternalLink size={12} className="ml-auto flex-shrink-0 opacity-50" />}
      {badgeCount != null && badgeCount > 0 && (
        <span
          className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white tabular-nums ${
            badgeTone === "red" ? "bg-red-500" : "bg-amber-500/90"
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
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={className}>
        {inner}
      </a>
    );
  }

  return (
    <Link href={item.href} className={className}>
      {inner}
    </Link>
  );
}
