import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { reconCandidates } from "@/lib/cleanup-system/statement-analysis";

export const dynamic = "force-dynamic";

/**
 * GET /api/portal/statement-accounts
 *
 * The bank / credit-card / loan accounts a client can pick from when the AI
 * couldn't auto-match an uploaded statement. Sourced from QBO when connected,
 * always merged with whatever the bookkeeper explicitly requested.
 */
export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ error: "No portal context" }, { status: 403 });
  const clientLinkId = ctxResult.ctx.clientLinkId;
  const service = createServiceSupabase();

  const options: { id: string | null; name: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, id: string | null) => {
    const key = name.toLowerCase().trim();
    if (!name.trim() || seen.has(key)) return;
    seen.add(key);
    options.push({ id, name });
  };

  // QBO bank/CC/loan accounts (best-effort).
  try {
    const { data: client } = await service
      .from("client_links")
      .select("qbo_realm_id, qbo_refresh_token")
      .eq("id", clientLinkId)
      .single();
    if ((client as any)?.qbo_realm_id && (client as any)?.qbo_refresh_token) {
      const token = await getValidToken(clientLinkId, service as any);
      const accounts = await fetchAllAccounts((client as any).qbo_realm_id, token);
      for (const c of reconCandidates(accounts)) add(c.name, String(c.id));
    }
  } catch {
    // no QBO — fall through to requested accounts only
  }

  // Whatever the bookkeeper requested by name.
  const { data: reqs } = await (service as any)
    .from("statement_requests")
    .select("account_name")
    .eq("client_link_id", clientLinkId)
    .eq("status", "open");
  for (const r of ((reqs as any[]) || [])) if (r.account_name) add(r.account_name, null);

  return NextResponse.json({ accounts: options });
}
