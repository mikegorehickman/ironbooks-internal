import { resolvePortalContextAllowNoQbo } from "@/lib/portal-context";
import { PortalErrorState } from "../error-state";
import { Mail, User, Briefcase, Calendar } from "lucide-react";
import { createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Settings — minimal v1. Shows the client what we know about them and
 * the client_link, plus a sign-in-method note. No edit yet (those land
 * in Day 7 polish if there's appetite).
 */
export default async function PortalSettings() {
  const ctxResult = await resolvePortalContextAllowNoQbo();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  // Pull the mapping metadata (invited_at, first_login_at) for the
  // "When you joined" line.
  const service = createServiceSupabase();
  const { data: mapping } = await service
    .from("client_users" as any)
    .select("invited_at, first_login_at")
    .eq("user_id", ctx.userId)
    .single();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Account</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Settings</h1>
      </div>

      <div className="bg-white border border-cardline rounded-2xl divide-y divide-slate-100">
        <Row icon={User} label="Name" value={ctx.userFullName || "—"} />
        <Row icon={Mail} label="Email" value={ctx.userEmail} />
        <Row icon={Briefcase} label="Business you can see" value={ctx.clientName} />
        {(mapping as any)?.invited_at && (
          <Row
            icon={Calendar}
            label="Joined"
            value={formatDate((mapping as any).invited_at)}
          />
        )}
      </div>

      <div className="bg-canvas border border-cardline rounded-xl p-4 text-xs text-ink-slate">
        <strong className="text-navy">How sign-in works:</strong> You sign in with a magic link to your
        email — no password to remember. To sign in from a new device, request a fresh magic link
        from the login page.
      </div>

      <div className="bg-canvas border border-cardline rounded-xl p-4 text-xs text-ink-slate">
        <strong className="text-navy">Need to update something?</strong> Email your Ironbooks
        bookkeeper to change your name or transfer access. We don't expose self-service for those
        yet — keeps your books safer.
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <Icon size={16} className="text-ink-slate flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">{label}</div>
        <div className="text-sm font-semibold text-navy mt-0.5 truncate">{value}</div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
