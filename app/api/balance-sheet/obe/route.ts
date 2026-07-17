import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchBalancesAsOf } from "@/lib/qbo-balance-sheet";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/balance-sheet/obe?client_link_id=...
 *
 * The Opening Balance Equity one-click: find the OBE account, read its live
 * balance, and hand back a proposed zeroing journal entry (OBE → Retained
 * Earnings) the bookkeeper reviews and posts via /api/balance-sheet/post-je.
 * Read-only. Nothing posts here.
 *
 * OBE is a QuickBooks artifact — the offset it invents when an opening
 * balance is typed on a new account. A clean balance sheet always has OBE = 0;
 * whatever sits there belongs in Retained Earnings (or owner equity). We never
 * guess the amount: we zero exactly the reported balance into RE and let the
 * human confirm before it posts.
 */
const OBE_RE = [/opening\s*balance\s*equity/i, /^obe$/i];
const RETAINED_RE = /retained\s*earnings/i;
const OWNER_EQUITY_RE = /(owner|member|shareholder).{0,4}(equity|capital)/i;

export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const clientLinkId = String(searchParams.get("client_link_id") || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const service = createServiceSupabase();
  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .maybeSingle();
  if (!client?.qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });
  }

  try {
    const token = await getValidToken(clientLinkId, service as any);
    const realm = client.qbo_realm_id as string;
    const accounts = await fetchAllAccounts(realm, token);

    const obeAcct = accounts.find(
      (a) => a.Active !== false && OBE_RE.some((re) => re.test(String(a.Name || "")))
    );
    if (!obeAcct) {
      return NextResponse.json({ obe: null, reason: "No Opening Balance Equity account on this file." });
    }

    // Live balance as of today from the Balance Sheet report (keyed by id).
    const today = new Date().toISOString().slice(0, 10);
    const balances = await fetchBalancesAsOf(realm, token, today);
    const balance = Math.round((balances.get(String(obeAcct.Id)) ?? 0) * 100) / 100;

    // Preferred target: Retained Earnings; fall back to owner/member equity.
    const target =
      accounts.find((a) => a.Active !== false && RETAINED_RE.test(String(a.Name || ""))) ||
      accounts.find((a) => a.Active !== false && OWNER_EQUITY_RE.test(String(a.Name || ""))) ||
      null;

    const abs = Math.abs(balance);
    // A positive reported equity balance is credit-normal → debit OBE to clear
    // it, credit the target. Negative flips both sides. Amounts always equal so
    // the entry is balanced.
    const obeSide: "debit" | "credit" = balance >= 0 ? "debit" : "credit";
    const targetSide: "debit" | "credit" = balance >= 0 ? "credit" : "debit";
    const proposed_lines =
      abs < 0.005
        ? []
        : [
            {
              side: obeSide,
              qbo_account_id: String(obeAcct.Id),
              account_hint: obeAcct.Name,
              amount: abs,
              description: "Zero Opening Balance Equity",
            },
            {
              side: targetSide,
              ...(target ? { qbo_account_id: String(target.Id) } : {}),
              account_hint: target?.Name || "Retained Earnings",
              amount: abs,
              description: "Move opening balance to retained earnings",
            },
          ];

    return NextResponse.json({
      obe: { id: String(obeAcct.Id), name: obeAcct.Name, balance },
      target: target ? { id: String(target.Id), name: target.Name } : null,
      is_clean: abs < 0.005,
      proposed_lines,
      memo: "Zero Opening Balance Equity into Retained Earnings (SNAP BS cleanup)",
      txn_date: today,
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
