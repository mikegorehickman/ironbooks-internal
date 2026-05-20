import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { listBalanceSheetAccounts } from "@/lib/qbo-balance-sheet";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/bs-accounts
 *
 * Returns the client's QBO Balance Sheet accounts grouped by kind
 * (bank / credit_card / loan), with last-4 digits where present.
 * Drives the account-picker on the Balance Sheet Cleanup landing page.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let accounts;
  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    accounts = await listBalanceSheetAccounts(
      (client as any).qbo_realm_id,
      accessToken
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: `Could not fetch QBO accounts: ${err?.message || err}` },
      { status: 500 }
    );
  }

  const grouped = {
    bank: accounts.filter((a) => a.kind === "bank"),
    credit_card: accounts.filter((a) => a.kind === "credit_card"),
    loan: accounts.filter((a) => a.kind === "loan"),
  };

  return NextResponse.json({
    client_name: (client as any).client_name,
    counts: {
      bank: grouped.bank.length,
      credit_card: grouped.credit_card.length,
      loan: grouped.loan.length,
    },
    accounts: grouped,
  });
}
