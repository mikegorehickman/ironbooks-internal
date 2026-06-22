import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { requireStaff } from "@/lib/cleanup-system/auth";

export const dynamic = "force-dynamic";

/**
 * GET  /api/clients/[id]/statement-requests        → all requests (any status)
 * POST /api/clients/[id]/statement-requests { items: [{label, account_name, account_kind, qbo_account_id?}] }
 *      → create open statement requests the client sees by their upload panel.
 * id = client_link_id.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data, error } = await (service as any)
    .from("statement_requests")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ requests: data || [] });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  const rows = items
    .filter((i: any) => i && typeof i.label === "string" && i.label.trim())
    .map((i: any) => ({
      client_link_id: clientLinkId,
      label: String(i.label).trim(),
      account_name: i.account_name ? String(i.account_name) : null,
      account_kind: i.account_kind ? String(i.account_kind) : null,
      qbo_account_id: i.qbo_account_id ? String(i.qbo_account_id) : null,
      requested_by: auth.userId,
    }));
  if (rows.length === 0) return NextResponse.json({ ok: true, created: 0 });

  const service = createServiceSupabase();
  // Don't duplicate an already-open request for the same account label.
  const { data: existing } = await (service as any)
    .from("statement_requests")
    .select("label")
    .eq("client_link_id", clientLinkId)
    .eq("status", "open");
  const openLabels = new Set(((existing as any[]) || []).map((r: any) => r.label));
  const fresh = rows.filter((r: any) => !openLabels.has(r.label));
  if (fresh.length === 0) return NextResponse.json({ ok: true, created: 0 });

  const { error } = await (service as any).from("statement_requests").insert(fresh);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, created: fresh.length });
}
