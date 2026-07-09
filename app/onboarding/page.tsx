import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { OnboardingBoard } from "./onboarding-board";
import type { OnboardingLead } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * /onboarding — new-sale → onboarding tracking board (admin/lead only).
 *
 * Fed by the GHL webhooks (won / ob-form / ob-call). Each card moves through
 * New sale → In onboarding → Ready, with SLA coloring so nothing stalls, and
 * a "Create client" handoff into the Cleanup board.
 */
export default async function OnboardingPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  // Active leads (converted ones leave the board; lost are hidden). Tolerate
  // the table not existing yet (migration 70 not run) — show empty state.
  let leads: OnboardingLead[] = [];
  try {
    const { data } = await (service as any)
      .from("onboarding_leads")
      .select("*")
      .eq("status", "active")
      // A lead linked to a client (client_link_id set) is already a client —
      // it isn't a "new sale" and shouldn't sit on the onboarding board, even
      // if its status was never flipped to 'converted'.
      .is("client_link_id", null)
      .order("won_at", { ascending: true, nullsFirst: false });
    leads = (data as OnboardingLead[]) || [];

    // Insurance for already-clients created OUTSIDE the funnel (e.g. migrated
    // from Double) whose lead was never linked: drop any lead whose email
    // already belongs to an active client. Case-insensitive.
    if (leads.length) {
      const { data: activeClients } = await service
        .from("client_links")
        .select("client_email")
        .eq("is_active", true);
      const clientEmails = new Set(
        ((activeClients as any[]) || [])
          .map((c) => (c.client_email || "").toLowerCase().trim())
          .filter(Boolean)
      );
      if (clientEmails.size) {
        leads = leads.filter(
          (l) => !clientEmails.has((l.email || "").toLowerCase().trim())
        );
      }
    }
  } catch {
    leads = [];
  }

  const { data: bks } = await service
    .from("users")
    .select("id, full_name, role")
    .eq("is_active", true)
    .in("role", ["admin", "lead", "bookkeeper"])
    .order("full_name");
  const bookkeepers = ((bks as any[]) || [])
    .filter((b) => b.full_name)
    .map((b) => ({ id: b.id, full_name: b.full_name }));

  return (
    <AppShell>
      <TopBar
        title="Onboarding"
        subtitle="New sales → onboarding form → onboarding call → client"
      />
      <div className="px-8 py-6">
        <OnboardingBoard leads={leads} bookkeepers={bookkeepers} />
      </div>
    </AppShell>
  );
}
