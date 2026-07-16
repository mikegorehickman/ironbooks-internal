import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchPLDetailAll, fetchProfitAndLoss } from "@/lib/qbo-reports";
import { incomeAccountNamesFromSummary } from "@/lib/crm-invoice-revenue";
import {
  buildExtractionPlan,
  classifyAccountKind,
  normalizeAccountKey,
  type GstInputKind,
} from "@/lib/gst-extraction";

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

  // Category input-kinds from the master COA (client industry, painters
  // fallback — same fallback chain the bank-rules page uses).
  const industry = ((client as any).industry as string) || "painters";
  let { data: coaRows } = await (service as any)
    .from("master_coa")
    .select("account_name, gst_input_kind")
    .eq("jurisdiction", "CA")
    .eq("industry", industry)
    .not("gst_input_kind", "is", null);
  if (!coaRows || coaRows.length === 0) {
    ({ data: coaRows } = await (service as any)
      .from("master_coa")
      .select("account_name, gst_input_kind")
      .eq("jurisdiction", "CA")
      .eq("industry", "painters")
      .not("gst_input_kind", "is", null));
  }
  // Keyed by NORMALIZED name — live QBO names differ from master names by
  // dash variants / "&" / punctuation (Maple City: "Subcontractors – Painting",
  // "Telephone & Internet" all missed an exact lowercase join).
  const kindByAccount = new Map<string, GstInputKind>(
    ((coaRows as any[]) || []).map((r) => [normalizeAccountKey(String(r.account_name)), r.gst_input_kind as GstInputKind])
  );
  if (kindByAccount.size === 0) {
    return NextResponse.json(
      { error: "master_coa has no gst_input_kind data — run migration 130 first" },
      { status: 400 }
    );
  }

  try {
    const token = await getValidToken(clientLinkId, service as any);
    const realm = (client as any).qbo_realm_id as string;
    const [plDetail, plSummary] = await Promise.all([
      fetchPLDetailAll(realm, token, start, end, "Cash"),
      fetchProfitAndLoss(realm, token, start, end, "Cash"),
    ]);
    const incomeAccounts = incomeAccountNamesFromSummary(plSummary);

    // Heuristic fallback for off-master expense accounts: classify by name
    // pattern (same rules migration 130 seeded with) so "Rent - storage" or
    // "Online Advertising – Google Ads" still get a plan. Every heuristic
    // assignment is returned for review — only null-classified names stay
    // unknown (and get no split).
    const heuristicKinds: Array<{ account: string; kind: GstInputKind }> = [];
    for (const row of plDetail) {
      const key = normalizeAccountKey(row.account);
      if (!key || kindByAccount.has(key)) continue;
      const kind = classifyAccountKind(row.account);
      if (kind) {
        kindByAccount.set(key, kind);
        heuristicKinds.push({ account: row.account, kind });
      }
    }
    heuristicKinds.sort((a, b) => a.account.localeCompare(b.account));

    const plan = buildExtractionPlan(plDetail, province, incomeAccounts, kindByAccount);
    if (!plan) {
      return NextResponse.json(
        { error: `Province "${province || "(none)"}" isn't a recognized Canadian province — set it on the client profile first` },
        { status: 400 }
      );
    }

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
