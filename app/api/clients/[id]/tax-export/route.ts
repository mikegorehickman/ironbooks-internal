import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { buildTaxExport } from "@/lib/tax-export";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/clients/[id]/tax-export?start=YYYY-MM-DD&end=YYYY-MM-DD */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "start and end (YYYY-MM-DD) are required" }, { status: 400 });
  }
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, state_province")
    .eq("id", id)
    .single();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "Client has no QBO connection" }, { status: 400 });
  try {
    const result = await buildTaxExport(service, client as any, { start, end });
    try {
      await service.from("audit_log").insert({
        event_type: "tax_export_generated",
        user_id: user.id,
        request_payload: { client_link_id: id, start, end, unmapped: result.unmapped.length } as any,
      });
    } catch {}
    return NextResponse.json({ ok: true, client_name: client.client_name, jurisdiction: client.jurisdiction, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Export failed" }, { status: 502 });
  }
}
