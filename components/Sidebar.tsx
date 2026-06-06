"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home, Sparkles, Flag, Users, LogOut, BookOpen, Clock,
  Zap, Shield, Shuffle, CreditCard, ChevronDown, ChevronRight, Receipt, KanbanSquare, Sun,
  FileSpreadsheet, Wallet, Volume2, VolumeX, HeartPulse, Gauge, CalendarCheck,
  ClipboardCheck,
} from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";
import type { Database } from "@/lib/database.types";
import { StripeConnectModal } from "./StripeConnectModal";
import { isMuted, setMuted, onMutedChange } from "@/lib/sounds";

const standardItems = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/today", label: "Today", icon: Sun },
  { href: "/kanban", label: "Workflow", icon: KanbanSquare },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/advisor", label: "Strategic Advisor", icon: HeartPulse },
  { href: "/templates", label: "Master COA", icon: BookOpen },
  { href: "/history", label: "Job History", icon: Clock },
];

// Visible only to admin + lead
const seniorItems = [
  { href: "/fleet", label: "Fleet Health", icon: Gauge },
  { href: "/month-end", label: "Month-End", icon: CalendarCheck },
  { href: "/balance-sheet/cleanup", label: "BS Cleanup", icon: ClipboardCheck },
  { href: "/flagged", label: "Flagged Queue", icon: Flag },
];

const advancedItems = [
  { href: "/reclass/new", label: "Reclassify (standalone)", icon: Shuffle },
  { href: "/rules/new", label: "Bank Rules (standalone)", icon: Zap },
  { href: "/stripe-recon/new", label: "Stripe Recon (standalone)", icon: CreditCard },
  { href: "/balance-sheet/coa", label: "BS COA Editor", icon: FileSpreadsheet },
  { href: "/balance-sheet/ar-recovery", label: "A/R Recovery", icon: Wallet },
  { href: "/tax-audit", label: "GST/HST Audit (CA)", icon: Receipt },
];

const adminItems = [
  { href: "/admin", label: "Admin", icon: Shield },
  { href: "/admin/audit", label: "Audit Log", icon: BookOpen },
];

export function Sidebar() {
  const pathname = usePathname();
  const [userName, setUserName] = useState<string>("");
  const [userRole, setUserRole] = useState<string>("");
  const [flaggedCount, setFlaggedCount] = useState(0);
  const [stripeModalOpen, setStripeModalOpen] = useState(false);

  // Advanced section is collapsed by default; auto-open if user lands on one of its routes
  const isOnAdvancedRoute = advancedItems.some((i) => pathname.startsWith(i.href));
  const [advancedOpen, setAdvancedOpen] = useState(isOnAdvancedRoute);
  useEffect(() => {
    if (isOnAdvancedRoute) setAdvancedOpen(true);
  }, [isOnAdvancedRoute]);

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

          // Pull real flagged count for seniors — 3 tables, same logic as dashboard
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

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth/login";
  }

  const isAdmin = userRole === "admin";
  const isSenior = userRole === "admin" || userRole === "lead";

  // Active state for the primary CTA — match any /jobs/* route or in-flight workflow pages
  const cleanupActive =
    pathname.startsWith("/jobs/") ||
    pathname.startsWith("/reclass/") && /\/(reclass)\/[^/]+\//.test(pathname) ||
    pathname.startsWith("/stripe-recon/") && /\/(stripe-recon)\/[^/]+\//.test(pathname) ||
    pathname.startsWith("/rules/") && /\/(rules)\/[^/]+\//.test(pathname);

  return (
    <aside className="flex flex-col h-screen sticky top-0 w-60 bg-navy text-white">
      <div className="px-5 py-5 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <img
            src="/logo.png"
            alt="Ironbooks SNAP"
            className="w-10 h-10 object-contain flex-shrink-0"
          />
          <div>
            <div className="font-bold text-lg tracking-tight leading-none">Ironbooks SNAP</div>
            <div className="text-xs mt-0.5 text-white/50">Bookkeeper OS</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {/* PRIMARY CTA — single button that drives the whole workflow */}
        <Link
          href="/jobs/new"
          className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-bold transition-all mb-3 shadow-sm ${
            cleanupActive
              ? "bg-teal text-white"
              : "bg-teal hover:bg-teal-dark text-white"
          }`}
        >
          <Sparkles size={18} />
          <span>Start Account Cleanup</span>
        </Link>

        {standardItems.map((item) => (
          <NavItem key={item.href} item={item} pathname={pathname} />
        ))}

        {isSenior && seniorItems.map((item) => (
          <NavItem
            key={item.href}
            item={item}
            pathname={pathname}
            badgeCount={flaggedCount}
          />
        ))}

        {/* ADVANCED — collapsed by default */}
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 mt-3 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors"
        >
          {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced
        </button>
        {advancedOpen && (
          <div className="space-y-0.5">
            {advancedItems.map((item) => (
              <NavItem key={item.href} item={item} pathname={pathname} dim />
            ))}
          </div>
        )}

        {isAdmin && (
          <>
            <div className="mt-4 mb-2 px-3 text-xs font-bold uppercase tracking-wider text-white/40">
              Admin
            </div>
            {adminItems.map((item) => (
              <NavItem key={item.href} item={item} pathname={pathname} />
            ))}
          </>
        )}

      </nav>

      {/* Stripe Connect Link — purple stylized button above the account block */}
      <div className="px-3 pt-3">
        <button
          onClick={() => setStripeModalOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-white shadow-md transition-all hover:scale-[1.02]"
          style={{
            background: "linear-gradient(135deg, #635BFF 0%, #7C3AED 100%)",
          }}
        >
          <CreditCard size={14} />
          Stripe Connect Link
        </button>
      </div>

      <div className="px-3 py-4 border-t border-white/10 mt-2">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg bg-white/5">
          <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-8 h-8 bg-teal">
            {userName.charAt(0) || "?"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">
              {userName || "Loading..."}
            </div>
            <div className="text-xs leading-tight truncate text-white/50 capitalize">
              {userRole}
            </div>
          </div>
          <SoundToggle />
          <button onClick={handleSignOut} className="text-white/40 hover:text-white transition-colors">
            <LogOut size={15} />
          </button>
        </div>
      </div>
      {stripeModalOpen && <StripeConnectModal onClose={() => setStripeModalOpen(false)} />}
    </aside>
  );
}

/**
 * Sidebar mute toggle for SNAP sound effects. State persisted per-user in
 * localStorage (managed by lib/sounds.ts). Hooks into the global
 * snap-sounds-muted-change event so any other surface that flips the
 * setting keeps this icon in sync.
 */
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
  dim,
}: {
  item: { href: string; label: string; icon: any };
  pathname: string;
  badgeCount?: number;
  dim?: boolean;
}) {
  const active = pathname === item.href || pathname.startsWith(item.href + "/");
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all mb-0.5 ${
        active
          ? "bg-teal/25 text-white border-l-[3px] border-teal pl-[9px]"
          : dim
          ? "text-white/45 hover:bg-white/5 hover:text-white/80"
          : "text-white/65 hover:bg-white/5 hover:text-white"
      }`}
    >
      <Icon size={dim ? 14 : 17} />
      <span className={dim ? "text-[13px]" : ""}>{item.label}</span>
      {badgeCount != null && badgeCount > 0 && (
        <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500 text-white">
          {badgeCount}
        </span>
      )}
    </Link>
  );
}
