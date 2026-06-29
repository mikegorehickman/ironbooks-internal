import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { runDunning } from "@/lib/billing-dunning";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/billing/dunning            — run the dunning pass now.
 * POST /api/admin/billing/dunning { hold }    — manual hold control:
 *      { client_link_id, hold: true|false }   place/release a portal billing hold.
 * Admin/lead/billing_admin only.
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

  // Manual hold toggle for one client.
  if (b.client_link_id && typeof b.hold === "boolean") {
    await service.from("client_links").update({
      portal_billing_hold: b.hold,
      billing_hold_at: b.hold ? new Date().toISOString() : null,
      billing_hold_reason: b.hold ? (b.reason || "Manual billing hold") : null,
    } as any).eq("id", b.client_link_id);
    await service.from("audit_log").insert({
      user_id: user.id, event_type: b.hold ? "billing_hold_placed" : "billing_hold_released",
      request_payload: { client_link_id: b.client_link_id } as any,
    });
    return NextResponse.json({ ok: true });
  }

  // Otherwise: run the full dunning pass.
  const origin = new URL(request.url).origin;
  const result = await runDunning(service, { origin, actorId: user.id });
  await service.from("audit_log").insert({ user_id: user.id, event_type: "billing_dunning_run", request_payload: result as any });
  return NextResponse.json({ ok: true, ...result });
}
