import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, QBOReauthRequiredError } from "@/lib/qbo";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { detectLaborDuplication } from "@/lib/payroll-double-entry";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/payroll-double-scan — READ-ONLY per-client scan for the
 * cross-account labor double-count (confirmed on BMD 2026-07-17: QBO Payroll
 * paycheques book gross wages to one account while the bank-feed net-pay
 * e-Transfers / Intuit deposits get expensed to a SECOND labor-ish account).
 *
 * One ProfitAndLossDetail (Accrual) fetch per client, then the pure
 * detectLaborDuplication. The /admin/payroll-double-scan page loops the fleet
 * in the browser (one client per request — small, isolated, no timeout).
 *
 * Body: { client_link_id: string, start_date?, end_date? }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = String(body.client_link_id || "");
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start_date) ? body.start_date : `${new Date().getFullYear()}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end_date) ? body.end_date : new Date().toISOString().slice(0, 10);

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 400 });
  }

  try {
    const token = await getValidToken(clientLinkId, service as any, "ironbooks/api/admin/payroll-double-scan");
    const rows = await fetchPLDetailAll((client as any).qbo_realm_id, token, start, end, "Accrual");
    const result = detectLaborDuplication(
      rows.map((r) => ({ account: r.account, txn_type: r.txn_type, name: r.name, amount: r.amount, memo: r.memo, date: r.date })),
    );
    return NextResponse.json({
      ok: true,
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      window: { start, end },
      ...result,
    });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) {
      return NextResponse.json({ reauth: true, client_link_id: clientLinkId, error: "QBO reconnect required" }, { status: 200 });
    }
    return NextResponse.json({ error: err.message, client_link_id: clientLinkId }, { status: 500 });
  }
}
