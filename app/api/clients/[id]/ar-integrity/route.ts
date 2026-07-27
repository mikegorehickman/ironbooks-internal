import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { scanClientArIntegrity } from "@/lib/ar-integrity-server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/clients/[id]/ar-integrity — is this client's A/R real?
 *
 * Powers the A/R verdict on cleanup step 4 (Revenue integrity). Read-only
 * against QBO: open invoices + trailing revenue in, verdict out. Diagnoses
 * unmatched invoices (collected but never applied to their deposit) — it does
 * not write to the ledger.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, fiscal_year_end, revenue_recognition_mode")
    .eq("id", id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id) {
    return NextResponse.json({ error: "This client has no QuickBooks connection." }, { status: 400 });
  }

  try {
    const report = await scanClientArIntegrity(service, client as any);
    return NextResponse.json({ ok: true, client_name: (client as any).client_name, report });
  } catch (e: any) {
    console.error(`[ar-integrity ${id}]`, e?.message);
    return NextResponse.json({ error: e?.message || "A/R scan failed" }, { status: 502 });
  }
}
