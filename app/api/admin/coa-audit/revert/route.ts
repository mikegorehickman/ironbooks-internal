import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccountsIncludingInactive, qboErrorResponse } from "@/lib/qbo";
import { fetchBalancesAsOf } from "@/lib/qbo-balance-sheet";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/coa-audit/revert  { client_link_id }   (READ-ONLY PLAN)
 *
 * Builds — and ONLY builds — the reversal plan for undoing a COA-audit
 * "Fix all" (Clean Cut incident, 2026-07-18: a completed manual cleanup was
 * overwritten). No writes. This produces the exact steps a human or a later
 * guarded executor follows, from two reliable signals:
 *
 *  1. RE-TYPES: the engine renamed each original account aside with a
 *     "(pre-retype …)" suffix and left it INACTIVE with its ORIGINAL type
 *     intact, then created a new same-name account of the master type and
 *     drained into it. So the original is recoverable — pair the active
 *     twin with its "(pre-retype)" inactive original, move the balance back,
 *     reactivate the original (drop the suffix), inactivate the created twin.
 *
 *  2. MERGES: every moved txn/JE carries the memo
 *     `SNAP COA merge: "source" → "target"`, and audit_log records each
 *     merge — so the moves are findable and the direction is known.
 *
 * NB: this endpoint does NOT write to QBO. Execution is a separate, guarded,
 * one-account-at-a-time step that only runs on explicit go-ahead.
 */
const PRE_RETYPE_RE = /\s*\(pre-retype[^)]*\)\s*$/i;
const norm = (s: string) => s.replace(PRE_RETYPE_RE, "").replace(/\s*\(deleted\)\s*$/i, "").trim().toLowerCase();

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = String(body.client_link_id || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", clientLinkId)
    .maybeSingle();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });

  try {
    const realm = client.qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);
    // BS balances (by account id) for balance-sheet accounts; P&L balances (by
    // account NAME) for income/COGS/expense accounts — the Balance Sheet report
    // omits P&L accounts, so the wage/COGS twins would otherwise read $0. YTD
    // covers the whole current year so a just-drained twin still shows its total.
    const year = new Date().getFullYear();
    const [accounts, balances, pl] = await Promise.all([
      fetchAllAccountsIncludingInactive(realm, token),
      fetchBalancesAsOf(realm, token, new Date().toISOString().slice(0, 10)).catch(() => new Map<string, number>()),
      fetchProfitAndLoss(realm, token, `${year}-01-01`, new Date().toISOString().slice(0, 10)).catch(() => null),
    ]);
    const plByName = new Map<string, number>();
    for (const li of (pl?.lineItems as any[]) || []) {
      const k = String(li.label || "").trim().toLowerCase();
      plByName.set(k, Math.round(((plByName.get(k) || 0) + (Number(li.amount) || 0)) * 100) / 100);
    }
    // Prefer the P&L balance (by name) for P&L accounts, else the BS balance.
    const balOf = (acct: any) => {
      const byName = plByName.get(String(acct?.Name || "").trim().toLowerCase());
      if (byName != null && Math.abs(byName) > 0.005) return byName;
      return Math.round((balances.get(String(acct?.Id)) ?? 0) * 100) / 100;
    };

    // ── 1. Re-type reversals — pair "(pre-retype)" originals with their twins ──
    const preRetype = accounts.filter((a: any) => PRE_RETYPE_RE.test(String(a.Name || "")));
    const activeByNorm = new Map<string, any>();
    for (const a of accounts) {
      if (a.Active !== false && !PRE_RETYPE_RE.test(String(a.Name || ""))) activeByNorm.set(norm(String(a.Name)), a);
    }
    const retypeReversals = preRetype.map((orig: any) => {
      const base = String(orig.Name).replace(PRE_RETYPE_RE, "").trim();
      const twin = activeByNorm.get(norm(base)) || null;
      return {
        original_account: base,
        original_id: String(orig.Id),
        original_type: orig.AccountType,
        original_active: orig.Active !== false,
        created_twin: twin ? twin.Name : null,
        created_twin_id: twin ? String(twin.Id) : null,
        created_twin_type: twin ? twin.AccountType : null,
        balance_on_twin_to_move_back: twin ? balOf(twin) : 0,
        steps: twin
          ? [
              `Move ${twin.AccountType} balance ($${Math.abs(balOf(twin)).toLocaleString()}) from "${twin.Name}" back to "${base}"`,
              `Reactivate "${base}" (drop the "(pre-retype)" suffix, restore type ${orig.AccountType})`,
              `Inactivate the created twin "${twin.Name}"`,
            ]
          : [`Reactivate "${base}" — no active twin found; verify the balance manually`],
      };
    });

    // ── 2. Merge reversals — from audit_log ──
    const { data: mergeRows } = await (service as any)
      .from("audit_log")
      .select("request_payload, occurred_at")
      .filter("request_payload->>client_link_id", "eq", clientLinkId)
      .eq("event_type", "coa_audit_merge")
      .order("occurred_at", { ascending: false })
      .limit(200);
    const mergeReversals = ((mergeRows as any[]) || []).map((r) => {
      const p = r.request_payload || {};
      return {
        at: r.occurred_at,
        source: p.source,
        target: p.target,
        amount_swept: p.amount_swept,
        lines_moved: p.lines_moved,
        jes_posted: p.jes_posted,
        source_inactivated: p.inactivated,
        find_by_memo: `SNAP COA merge: "${p.source}" → "${p.target}"`,
        steps: [
          `Find target "${p.target}" transactions/JEs with memo \`SNAP COA merge: "${p.source}" → "${p.target}"\``,
          `Move them back to "${p.source}" (${p.lines_moved ?? "?"} lines, $${Math.round(p.amount_swept || 0).toLocaleString()})`,
          p.inactivated ? `Reactivate "${p.source}"` : `"${p.source}" was left active — no reactivation needed`,
        ],
      };
    });

    const totalRetypeMoveBack = retypeReversals.reduce((s, r) => s + Math.abs(r.balance_on_twin_to_move_back), 0);
    const totalMergeMoveBack = mergeReversals.reduce((s, r) => s + Math.abs(Number(r.amount_swept) || 0), 0);

    return NextResponse.json({
      client: { id: client.id, name: client.client_name },
      dry_run: true,
      writes: "NONE — this is a plan only",
      summary: {
        retype_reversals: retypeReversals.length,
        merge_reversals: mergeReversals.length,
        total_to_move_back: Math.round((totalRetypeMoveBack + totalMergeMoveBack) * 100) / 100,
      },
      retype_reversals: retypeReversals,
      merge_reversals: mergeReversals,
      note:
        "Review this plan. Execution (the QBO writes) is a separate guarded step, run one account at a time on explicit go-ahead. " +
        "The same steps can be done by hand in QuickBooks: reactivate the (pre-retype) originals, and use Reclassify Transactions / the memo filter to move balances back.",
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
