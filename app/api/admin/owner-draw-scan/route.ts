import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { scanOwnerDraw, type OwnerDrawRow } from "@/lib/owner-draw-split";

/**
 * POST /api/admin/owner-draw-scan   (READ-ONLY)
 *
 * Per-client scan for owner compensation that hasn't been ruled salary vs draw.
 *
 * Migration 79 split the master COA into "Owner's Payroll" (expense) and
 * "Owner's Draw" (equity), but transactions were left where they were. Every
 * dollar on the wrong side moves net profit by that dollar, which makes this the
 * most margin-distorting misclassification we carry — and precisely the kind of
 * call that must NOT be automated: whether an owner is genuinely on payroll is a
 * fact about their arrangement, not something a pattern can settle.
 *
 * So this endpoint only reports. It returns each owner account, what it holds,
 * which way the evidence leans and why, and what net profit would do if the
 * "draw" leaning were accepted. A lead decides; the reclass is then a normal
 * reviewed move (the equity target must exist in the client's chart first —
 * "Owner's Draw" is a balance-sheet account, so it is NOT created by the
 * P&L-only master COA push).
 *
 * Body: { client_link_id: string, start_date?: string, end_date?: string }
 * Admin / lead only. One client per request so the fleet page can loop without
 * timing out (same shape as /api/admin/payroll-double-scan).
 */
export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

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
  if (!clientLinkId) {
    return NextResponse.json({ error: "client_link_id is required" }, { status: 400 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id || (client as any).is_active === false) {
    return NextResponse.json({ error: "Client is inactive or has no QBO connection" }, { status: 400 });
  }

  // Default window: this calendar year. Owner comp is a pattern over months, not
  // a single transaction, so a short window would hide the cycle that tells
  // payroll from draws.
  const year = new Date().getFullYear();
  const start = String(body.start_date || `${year}-01-01`).slice(0, 10);
  const end = String(body.end_date || new Date().toISOString().slice(0, 10)).slice(0, 10);

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);

    // Accrual: we want every posting, including ones a cash-basis view hides.
    const plRows = await fetchPLDetailAll(realm, token, start, end, "Accrual");
    const rows: OwnerDrawRow[] = plRows.map((r) => ({
      account: r.account,
      txn_type: r.txn_type,
      date: r.date,
      name: r.name,
      memo: r.memo,
      amount: r.amount,
      txn_id: r.txn_id,
    }));

    const scan = scanOwnerDraw(rows);

    return NextResponse.json({
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      window: { start, end },
      ...scan,
      // Spelled out because the number is the point: this much net profit is
      // currently understated if these are distributions rather than wages.
      summary: scan.needsSeniorReview
        ? `${scan.findings.filter((f) => f.needsReview).length} owner account(s) need a salary-vs-draw ruling` +
          (scan.profitImpactIfDraw !== 0
            ? ` · net profit understated by up to $${Math.abs(Math.round(scan.profitImpactIfDraw)).toLocaleString()} if ruled draws`
            : "")
        : "Owner compensation is already unambiguous — nothing to rule on",
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
