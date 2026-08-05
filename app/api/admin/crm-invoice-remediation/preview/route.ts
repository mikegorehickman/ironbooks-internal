import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { summarizeRemediation } from "@/lib/crm-invoice-remediation";
import { buildRemediationPreview } from "@/lib/crm-invoice-remediation-preview";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/crm-invoice-remediation/preview  (READ-ONLY)
 *   { client_link_id, start?, end? }
 *
 * The full scope + safety check before any QBO write: every CRM invoice
 * RECOGNIZED as revenue on the cash P&L, each with its linked payment(s) and
 * where each payment sits — Undeposited-Funds phantom (safe to void) vs a real
 * bank deposit (review). Feeds the "Fix in QuickBooks" panel. No writes.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || "") ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end || "") ? body.end : new Date().toISOString().slice(0, 10);

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, revenue_recognition_mode")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "no QBO connection" }, { status: 404 });
  const realm = (client as any).qbo_realm_id as string;

  try {
    const token = await getValidToken(clientLinkId, service as any);
    const invoices = await buildRemediationPreview(realm, token, start, end);
    return NextResponse.json({
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      revenue_recognition_mode: (client as any).revenue_recognition_mode || "standard",
      window: { start, end },
      summary: summarizeRemediation(invoices),
      invoices,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "preview failed" }, { status: 502 });
  }
}
