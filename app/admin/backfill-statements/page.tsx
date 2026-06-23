import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BackfillClient } from "./backfill-client";

export const dynamic = "force-dynamic";

/**
 * /admin/backfill-statements
 *
 * One-time tool to send the May 2026 statements for the production clients that
 * were marked "complete" before completing actually sent anything (Group A —
 * portal access but zero published statements). Reuses the live close path
 * (reopen → complete, which now publishes + emails), running under the admin's
 * own session, so this is identical to closing each card by hand — just batched.
 */
export default async function BackfillStatementsPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/dashboard");

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-navy">Backfill May 2026 statements</h1>
      <p className="text-sm text-ink-slate mt-1 leading-relaxed">
        These clients were marked complete without statements ever being sent. Each row reopens
        the May close and re-runs it through the real send path — publishing to their portal,
        emailing the client, and setting the QuickBooks closing date. Pilot one first (XPaint),
        then run the rest.
      </p>
      <BackfillClient />
    </div>
  );
}
