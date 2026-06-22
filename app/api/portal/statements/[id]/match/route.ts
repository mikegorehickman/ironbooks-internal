import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { fulfillStatementRequests } from "@/lib/statement-intake";

export const dynamic = "force-dynamic";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * POST /api/portal/statements/[id]/match { account_name, qbo_account_id? }
 *
 * Client-side manual match when the AI couldn't place an uploaded statement.
 * Sets the account, recomputes the display name, marks it processed, and
 * clears any open request it satisfies. id = client_statements.id.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ error: "No portal context" }, { status: 403 });
  const clientLinkId = ctxResult.ctx.clientLinkId;

  const body = await request.json().catch(() => ({}));
  const accountName = typeof body.account_name === "string" ? body.account_name.trim() : "";
  const qboAccountId = typeof body.qbo_account_id === "string" && body.qbo_account_id ? body.qbo_account_id : null;
  if (!accountName) return NextResponse.json({ error: "Pick an account" }, { status: 400 });

  const service = createServiceSupabase();
  // Ownership: the statement must belong to this client.
  const { data: stmt } = await (service as any)
    .from("client_statements")
    .select("id, client_link_id, period_month, period_year, original_name")
    .eq("id", id)
    .single();
  if (!stmt || stmt.client_link_id !== clientLinkId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const period =
    stmt.period_month && stmt.period_year
      ? `${MONTHS[stmt.period_month]} ${stmt.period_year}`
      : stmt.period_year ? String(stmt.period_year) : "";
  const displayName = period ? `${accountName} – ${period}` : accountName;

  const { error } = await (service as any)
    .from("client_statements")
    .update({
      matched_account_name: accountName,
      matched_qbo_account_id: qboAccountId,
      match_confidence: "manual",
      display_name: displayName,
      status: "processed",
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await fulfillStatementRequests(service, clientLinkId, {
    id,
    matched_qbo_account_id: qboAccountId,
    matched_account_name: accountName,
    account_label: null,
    last4: null,
  }).catch(() => {});

  return NextResponse.json({ ok: true, display_name: displayName });
}
