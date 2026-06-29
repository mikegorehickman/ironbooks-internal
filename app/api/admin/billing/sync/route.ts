import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { syncBilling } from "@/lib/billing-sync";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/billing/sync  { year?: number }
 * Matches active clients to Stripe customers and refreshes MRR + collected
 * payments for the year. Admin/lead only. Read-only against Stripe.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const year = Number.isInteger(body.year) ? body.year : new Date().getUTCFullYear();

  try {
    const result = await syncBilling(service, year);
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "billing_synced",
      request_payload: { year, ...result, unmatched_count: result.unmatched.length } as any,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Sync failed" }, { status: 500 });
  }
}
