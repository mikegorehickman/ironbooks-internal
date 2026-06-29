import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/billing/expected
 *   { client_link_id, mrr, currency? }   — set the expected monthly amount
 *   (subscription + payroll + anything else) as a manual override, and/or the
 *   currency. Admin/lead/billing_admin only.
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

  const b = await request.json().catch(() => ({}));
  const clientLinkId = b.client_link_id;
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const update: Record<string, any> = { client_link_id: clientLinkId, updated_at: new Date().toISOString() };
  if (b.mrr !== undefined && b.mrr !== null && b.mrr !== "") {
    const n = Number(b.mrr);
    if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    update.manual_mrr_cents = Math.round(n * 100);
  }
  if (b.currency && ["usd", "cad"].includes(String(b.currency).toLowerCase())) {
    update.currency = String(b.currency).toLowerCase();
  }
  // Expected payment day of month (1-31), e.g. 5 = paid on the 5th. Empty/null clears it.
  if (b.billing_day !== undefined) {
    if (b.billing_day === null || b.billing_day === "") {
      update.billing_day = null;
    } else {
      const d = Number(b.billing_day);
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        return NextResponse.json({ error: "Day must be 1–31" }, { status: 400 });
      }
      update.billing_day = d;
    }
  }

  const { error } = await (service as any)
    .from("billing_subscriptions")
    .upsert(update, { onConflict: "client_link_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
