import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/portal/statements
 *
 * Returns the client's own filed statements + their open statement requests,
 * so the upload panel can show "your bookkeeper needs…" and surface any
 * upload the AI couldn't match (for manual account selection). Refetched after
 * each upload/match so fulfilled requests drop off.
 */
export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ error: "No portal context" }, { status: 403 });
  const clientLinkId = ctxResult.ctx.clientLinkId;
  const service = createServiceSupabase();

  const [{ data: statements }, { data: requests }] = await Promise.all([
    (service as any)
      .from("client_statements")
      .select("id, display_name, original_name, status, matched_account_name, account_label, period_month, period_year, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(50),
    (service as any)
      .from("statement_requests")
      .select("id, label, account_name, account_kind")
      .eq("client_link_id", clientLinkId)
      .eq("status", "open")
      .order("created_at", { ascending: true }),
  ]);

  return NextResponse.json({
    statements: statements || [],
    requests: requests || [],
  });
}
