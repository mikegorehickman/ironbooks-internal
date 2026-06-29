import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST   /api/admin/billing/payment  — record a MANUAL payment (e-transfer,
 *        cheque, etc.) for a client + month. Body: { client_link_id, year,
 *        month, amount, status?, method?, kind?, note? }.
 * DELETE /api/admin/billing/payment?id=…  — remove a manual payment.
 * Admin/lead only. Only ever touches source='manual' rows.
 */
async function authActor() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, service: null as any };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) return { user: null, service };
  return { user, service };
}

export async function POST(request: Request) {
  const { user, service } = await authActor();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const b = await request.json().catch(() => ({}));
  const clientLinkId = b.client_link_id;
  const year = Number(b.year);
  const month = Number(b.month);
  const amount = Number(b.amount);
  if (!clientLinkId || !year || !month || month < 1 || month > 12 || !Number.isFinite(amount)) {
    return NextResponse.json({ error: "client_link_id, year, month (1-12) and amount are required" }, { status: 400 });
  }
  const status = ["collected", "failed", "expected", "comped"].includes(b.status) ? b.status : "collected";
  const method = typeof b.method === "string" && b.method ? b.method : "etransfer";
  const currency = ["usd", "cad"].includes(String(b.currency).toLowerCase()) ? String(b.currency).toLowerCase() : null;

  const { data: row, error } = await (service as any)
    .from("billing_payments")
    .insert({
      client_link_id: clientLinkId,
      period_year: year,
      period_month: month,
      amount_cents: Math.round(amount * 100),
      status,
      source: "manual",
      method,
      kind: b.kind || "other",
      currency,
      note: b.note ? String(b.note).slice(0, 500) : null,
      recorded_by: user.id,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: row.id });
}

export async function DELETE(request: Request) {
  const { user, service } = await authActor();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Manual rows only — never delete synced Stripe payments here.
  const { error } = await (service as any).from("billing_payments").delete().eq("id", id).eq("source", "manual");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
