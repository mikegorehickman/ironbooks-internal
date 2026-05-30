import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchProfitAndLossDetail } from "@/lib/qbo-reports";
import { fetchAccountTransactions } from "@/lib/qbo-balance-sheet";

/**
 * GET /api/clients/[id]/account-transactions?account_id=X&start=YYYY-MM-DD&end=YYYY-MM-DD&kind=pl|bs
 *
 * Internal twin of /api/portal/account-transactions. Where the portal
 * version derives the QBO realm + token from the signed-in client's
 * session, this version takes a client_link_id in the URL and uses
 * bookkeeper/admin/lead auth.
 *
 * `kind` selects which QBO report we hit:
 *   - "pl" → ProfitAndLossDetail (matches P&L line totals exactly)
 *   - "bs" → TransactionList (works for BS accounts where PL detail
 *     returns garbage because the account isn't an income/expense type)
 *
 * Both shapes are normalized to the same return so the UI doesn't have
 * to branch.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_TRANSACTIONS = 500;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  // Internal-only — clients use the portal route, not this one.
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!role || role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("account_id");
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const kind = (searchParams.get("kind") || "pl").toLowerCase() === "bs" ? "bs" : "pl";

  if (!accountId) return NextResponse.json({ error: "account_id required" }, { status: 400 });
  if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink || !(clientLink as any).qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or QBO not connected" }, { status: 404 });
  }
  const realmId = (clientLink as any).qbo_realm_id as string;

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);

    // Normalize both report shapes into a single response. Both helpers
    // already filter to a single account, so we just remap field names.
    if (kind === "pl") {
      const rows = await fetchProfitAndLossDetail(realmId, accessToken, accountId, start, end);
      const truncated = rows.length > MAX_TRANSACTIONS;
      const trimmed = truncated ? rows.slice(0, MAX_TRANSACTIONS) : rows;
      return NextResponse.json({
        kind: "pl",
        total: rows.length,
        truncated,
        transactions: trimmed.map((t) => ({
          id: t.txn_id,
          type: t.txn_type,
          date: t.date,
          doc_number: t.doc_number,
          name: t.name,
          memo: t.memo,
          amount: t.amount,
          running_balance: t.running_balance,
        })),
      });
    }

    // kind === "bs"
    const rows = await fetchAccountTransactions(realmId, accessToken, accountId, start, end);
    const truncated = rows.length > MAX_TRANSACTIONS;
    const trimmed = truncated ? rows.slice(0, MAX_TRANSACTIONS) : rows;
    return NextResponse.json({
      kind: "bs",
      total: rows.length,
      truncated,
      transactions: trimmed.map((t) => ({
        id: t.txn_id,
        type: t.txn_type,
        date: t.date,
        doc_number: t.doc_number,
        name: t.customer_or_vendor,
        memo: t.memo,
        amount: t.amount,
        // TransactionList doesn't return a running balance per row, but
        // it does include a cleared flag we surface in the UI as "✓ Cleared"
        cleared: t.cleared,
        running_balance: null,
      })),
    });
  } catch (err: any) {
    console.warn(`[client-account-transactions] failed:`, err?.message);
    return NextResponse.json(
      { error: err?.message || "Failed to fetch transactions" },
      { status: 500 }
    );
  }
}
