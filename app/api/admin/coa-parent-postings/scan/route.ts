import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { detectParentPostings } from "@/lib/coa-parent-postings";

/**
 * POST /api/admin/coa-parent-postings/scan   { client_link_id }   (READ-ONLY)
 *
 * One client's parent accounts that carry DIRECT postings (money booked on a
 * parent that has sub-accounts — QBO's "[Parent] – Other"). The fleet button
 * on /coa-audit loops this per client. No writes. Admin / lead.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!(client as any)?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);
    const year = new Date().getFullYear();
    const start = `${year}-01-01`;
    const end = new Date().toISOString().slice(0, 10);
    const [accounts, pl] = await Promise.all([
      fetchAllAccounts(realm, token),
      fetchProfitAndLoss(realm, token, start, end),
    ]);
    const parents = detectParentPostings(accounts as any, (pl?.lineItems as any) || []);
    const total = Math.round(parents.reduce((s, p) => s + Math.abs(p.amount), 0) * 100) / 100;
    return NextResponse.json({
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      window: { start, end },
      count: parents.length,
      total,
      parents,
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
