import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/billing/cell-note
 *   { client_link_id, year, month, note }
 * Upsert (or clear, when note is empty) the note on one billing grid cell.
 * Shown on hover in /admin/billing. Admin/lead/billing_admin only.
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
  const year = Number(b.year);
  const month = Number(b.month);
  if (!clientLinkId || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "client_link_id, year and month (1-12) required" }, { status: 400 });
  }
  const note = typeof b.note === "string" ? b.note.trim() : "";

  if (!note) {
    await (service as any).from("billing_cell_notes").delete()
      .eq("client_link_id", clientLinkId).eq("period_year", year).eq("period_month", month);
    return NextResponse.json({ ok: true, cleared: true });
  }

  const { error } = await (service as any).from("billing_cell_notes").upsert(
    {
      client_link_id: clientLinkId, period_year: year, period_month: month,
      note: note.slice(0, 1000), updated_by: user.id, updated_at: new Date().toISOString(),
    },
    { onConflict: "client_link_id,period_year,period_month" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
