import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { resolveExtractionContext } from "@/lib/gst-extraction-server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/gst-extraction/preview   (READ-ONLY)
 *   { client_link_id, start?, end? }
 *
 * Full per-transaction GST/HST/PST extraction plan for one Canadian client:
 * every income deposit with its proposed net/GST/PST split, every taxable
 * expense line with its proposed ITC, totals per side, and the review lists
 * (unknown expense accounts, already-split transactions). Validate the split
 * math on a small account BEFORE the apply writers run anywhere. No writes.
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
    .select("id, client_name, qbo_realm_id, jurisdiction, state_province, industry, gst_number, pst_number")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "no QBO connection" }, { status: 404 });

  const province = ((client as any).state_province || "").toUpperCase();
  if ((client as any).jurisdiction !== "CA") {
    return NextResponse.json(
      { error: `${(client as any).client_name} is not a Canadian client (jurisdiction=${(client as any).jurisdiction || "?"}) — GST extraction doesn't apply` },
      { status: 400 }
    );
  }

  const excludeVendors: string[] = Array.isArray(body.exclude_vendors)
    ? body.exclude_vendors.map(String)
    : [];

  try {
    const token = await getValidToken(clientLinkId, service as any);
    // SHARED resolver (lib/gst-extraction-server.ts) — the exact same context
    // the apply endpoint rebuilds, so preview and apply can never drift.
    const ctx = await resolveExtractionContext(service, client as any, token, start, end, excludeVendors);
    if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: 400 });
    const { plan, heuristicKinds } = ctx;

    const CAP = 2000;
    return NextResponse.json({
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      province,
      gst_number: (client as any).gst_number || null,
      pst_number: (client as any).pst_number || null,
      window: { start, end },
      accounts: plan.accounts,
      totals: plan.totals,
      skipped: plan.skipped,
      // Off-master accounts classified by name heuristics — the review list.
      heuristic_kinds: heuristicKinds,
      // ITC per vendor, largest first — spot unregistered small suppliers
      // (person-named vendors) and pass them back as exclude_vendors.
      vendor_itc_summary: plan.vendorItcSummary.slice(0, 100),
      deposit_count: plan.deposits.length,
      expense_count: plan.expenses.length,
      deposits: plan.deposits.slice(0, CAP),
      expenses: plan.expenses.slice(0, CAP),
      capped: plan.deposits.length > CAP || plan.expenses.length > CAP,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "preview failed" }, { status: 502 });
  }
}
