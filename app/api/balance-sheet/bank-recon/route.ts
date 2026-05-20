import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { listBalanceSheetAccounts } from "@/lib/qbo-balance-sheet";

/**
 * POST /api/balance-sheet/bank-recon
 *
 * Records a per-account reconciliation entry — the bookkeeper has
 * supplied the statement ending balance + date, we capture them and
 * snapshot the QBO ledger balance for that account at this moment.
 *
 * The deeper "find which QBO transactions explain the gap" stage
 * comes in a follow-up. For now this gives us the inputs + a row
 * the bookkeeper can return to later.
 *
 * Body:
 *   {
 *     client_link_id: string
 *     qbo_account_id: string
 *     statement_ending_balance: number
 *     statement_as_of_date: string  // YYYY-MM-DD
 *     notes?: string
 *   }
 *
 * Returns: { job_id, gap_amount }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const {
    client_link_id,
    qbo_account_id,
    statement_ending_balance,
    statement_as_of_date,
    notes,
  } = body || {};
  if (!client_link_id || !qbo_account_id || statement_ending_balance == null || !statement_as_of_date) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: client_link_id, qbo_account_id, statement_ending_balance, statement_as_of_date.",
      },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", client_link_id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Pull live account info from QBO for the snapshot.
  let accountInfo;
  try {
    const accessToken = await getValidToken(client_link_id, service as any);
    const all = await listBalanceSheetAccounts(
      (client as any).qbo_realm_id,
      accessToken
    );
    accountInfo = all.find((a) => a.qbo_account_id === qbo_account_id);
  } catch (err: any) {
    return NextResponse.json(
      { error: `Could not fetch account from QBO: ${err?.message}` },
      { status: 500 }
    );
  }
  if (!accountInfo) {
    return NextResponse.json(
      { error: "Account not found in QBO" },
      { status: 404 }
    );
  }

  // QBO's `CurrentBalance` is the live ledger balance — close enough for
  // an MVP gap calc. The "balance as of statement_as_of_date" version
  // (re-run the GL through that date) is a follow-up.
  const qboBalance = Number(accountInfo.current_balance || 0);
  const gap = Number(statement_ending_balance) - qboBalance;

  const { data: job, error: jobErr } = (await (service as any)
    .from("bank_recon_jobs")
    .insert({
      client_link_id,
      bookkeeper_id: user.id,
      qbo_account_id,
      qbo_account_name: accountInfo.name,
      qbo_account_type: accountInfo.account_type,
      qbo_account_last4: accountInfo.last4,
      statement_ending_balance: Number(statement_ending_balance),
      statement_as_of_date,
      qbo_balance_at_date: qboBalance,
      gap_amount: gap,
      status: "created",
      notes: notes || null,
    })
    .select()
    .single()) as any;
  if (jobErr || !job) {
    return NextResponse.json(
      { error: jobErr?.message || "Could not create recon job" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    job_id: (job as any).id,
    qbo_balance: qboBalance,
    gap_amount: gap,
  });
}
