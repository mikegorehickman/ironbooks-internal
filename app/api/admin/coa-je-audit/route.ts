import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import {
  scanClientForMergeJEs,
  isExcludedClient,
  MERGE_JE_AFFECTED_ACCOUNTS,
  MERGE_JE_EXCLUDED_CLIENTS,
} from "@/lib/coa-merge-je-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * COA-merge JE audit — READ-ONLY. Finds the lump journal entries the COA merge
 * tool posted (memo-fingerprinted) that collapsed GL detail on the affected
 * accounts. Nothing here writes to QBO.
 *
 * GET  → the affected-client roster (all active clients except the two Mike
 *        confirmed clean) + the affected-account list, for the audit page.
 * POST { clientLinkId, sinceDate? } → scan ONE client's QBO for merge JEs.
 */
async function requireSenior() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Senior only" }, { status: 403 }) };
  }
  return { user, service };
}

export async function GET() {
  const auth = await requireSenior();
  if ("error" in auth) return auth.error;

  const { data: clients } = await auth.service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("is_active", true)
    .order("client_name");

  const affected = ((clients as any[]) || [])
    .filter((c) => c.qbo_realm_id && !isExcludedClient(c.client_name))
    .map((c) => ({ id: c.id, client_name: c.client_name }));

  return NextResponse.json({
    clients: affected,
    excluded: MERGE_JE_EXCLUDED_CLIENTS,
    affectedAccounts: MERGE_JE_AFFECTED_ACCOUNTS,
  });
}

export async function POST(request: Request) {
  const auth = await requireSenior();
  if ("error" in auth) return auth.error;

  let body: { clientLinkId?: string; sinceDate?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.clientLinkId) return NextResponse.json({ error: "clientLinkId required" }, { status: 400 });

  const { data: client } = await auth.service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", body.clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (isExcludedClient((client as any).client_name)) {
    return NextResponse.json({ error: "This client is on the excluded (clean) list." }, { status: 400 });
  }
  if (!(client as any).qbo_realm_id) {
    return NextResponse.json({ error: "Client has no QBO connection." }, { status: 400 });
  }

  try {
    const token = await getValidToken(body.clientLinkId, auth.service as any, "ironbooks/api/admin/coa-je-audit");
    const result = await scanClientForMergeJEs((client as any).qbo_realm_id, token, {
      sinceDate: body.sinceDate,
    });
    const totalAffected = result.matched.reduce((s, r) => s + Math.abs(r.totalAmount), 0);
    return NextResponse.json({
      client_name: (client as any).client_name,
      scanned: result.scanned,
      matched_count: result.matched.length,
      matched_any_count: result.matchedAny.length,
      total_affected_amount: totalAffected,
      rows: result.matched,
      error: result.error || null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 502 });
  }
}
