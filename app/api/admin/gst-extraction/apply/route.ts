import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { getCompanyClosingDate } from "@/lib/qbo-reclass";
import { normalizeAccountKey } from "@/lib/gst-extraction";
import {
  resolveExtractionContext,
  ensureTaxAccounts,
  groupDepositPlans,
  groupExpensePlans,
  splitDepositTxn,
  splitExpenseTxn,
  type WriteOutcome,
} from "@/lib/gst-extraction-server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const MAX_TXNS_PER_PASS = 40;

/**
 * POST /api/admin/gst-extraction/apply   (WRITES TO QBO unless dry_run)
 *   { client_link_id, start?, end?, dry_run?: boolean (default TRUE),
 *     side?: "income" | "expenses" | "both" (default both) }
 *
 * Executes the extraction plan for one Canadian client: splits each income
 * deposit line into net + GST/HST Payable (+ PST Payable), and each taxable
 * expense line into net + GST/HST Recoverable (ITCs). Transaction totals
 * NEVER change — bank feeds/matches/recon untouched.
 *
 * Guards, every one server-side:
 *   1. Admin/lead only; CA-jurisdiction gate.
 *   2. dry_run defaults TRUE — pass dry_run:false to write.
 *   3. The plan is REBUILT live here (client payload never trusted).
 *   4. Exact line matching (account id + amount to the cent) — a line a human
 *      changed since the preview skips its whole transaction ("stale").
 *   5. Closed periods skipped; already-stamped transactions (memo marker)
 *      skipped; full pre-edit entity snapshot written to audit_log BEFORE
 *      each write (revert tool's data source).
 *   6. Budget-chunked: returns remaining counts; re-invoke until done=true.
 */
export async function POST(request: Request) {
  const startTime = Date.now();
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
  const dryRun = body.dry_run !== false; // default TRUE
  const side: "income" | "expenses" | "both" = ["income", "expenses"].includes(body.side) ? body.side : "both";
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || "") ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end || "") ? body.end : new Date().toISOString().slice(0, 10);

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, state_province, industry, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !client.is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }
  if ((client as any).jurisdiction !== "CA") {
    return NextResponse.json({ error: "Not a Canadian client — GST extraction doesn't apply" }, { status: 400 });
  }

  try {
    const token = await getValidToken(clientLinkId, service as any);
    const realm = (client as any).qbo_realm_id as string;

    // Re-plan live (guard 3). exclude_vendors carries through so ITC-excluded
    // vendors (unregistered small suppliers) hold on the real run too.
    const excludeVendors: string[] = Array.isArray(body.exclude_vendors)
      ? body.exclude_vendors.map(String)
      : [];
    const ctx = await resolveExtractionContext(service, client as any, token, start, end, excludeVendors);
    if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: 400 });
    const { plan } = ctx;

    const province = ((client as any).state_province || "").toUpperCase();
    const needPst = plan.deposits.some((d) => d.split.pst !== 0);
    const accounts = await ensureTaxAccounts(realm, token, province, needPst, dryRun);
    if (!dryRun && (!accounts.payable.id || !accounts.recoverable.id || (needPst && !accounts.pstPayable?.id))) {
      return NextResponse.json({ error: "Tax account creation failed — aborting before any split" }, { status: 502 });
    }

    // Resolve plan account NAMES → live QBO ids (normalized).
    const all = await fetchAllAccounts(realm, token);
    const accountIdByKey = new Map<string, string>();
    for (const a of all) {
      if (a.Active === false) continue;
      accountIdByKey.set(normalizeAccountKey(a.Name), a.Id);
      accountIdByKey.set(normalizeAccountKey(a.FullyQualifiedName || a.Name), a.Id);
    }

    const closingDate = await getCompanyClosingDate(realm, token).catch(() => null);

    const depositPlans = side === "expenses" ? new Map() : groupDepositPlans(plan.deposits, accountIdByKey);
    const expensePlans = side === "income" ? new Map() : groupExpensePlans(plan.expenses, accountIdByKey);

    const snapshot = (txnType: string, txnId: string) => async (entity: any) => {
      await service.from("audit_log").insert({
        event_type: "gst_extraction_snapshot",
        user_id: user.id,
        request_payload: { client_link_id: clientLinkId, txn_type: txnType, txn_id: txnId, entity } as any,
      } as any);
    };

    const results: { deposits: WriteOutcome[]; expenses: WriteOutcome[] } = { deposits: [], expenses: [] };
    let processed = 0;
    let remainingDeposits = 0;
    let remainingExpenses = 0;

    for (const [txnId, plans] of depositPlans) {
      if (Date.now() - startTime > BUDGET_MS || processed >= MAX_TXNS_PER_PASS) {
        remainingDeposits++;
        continue;
      }
      processed++;
      results.deposits.push(
        await splitDepositTxn(realm, token, txnId, plans, accounts, {
          dryRun,
          closingDate,
          snapshot: snapshot("Deposit", txnId),
        })
      );
    }
    for (const [txnId, group] of expensePlans) {
      if (Date.now() - startTime > BUDGET_MS || processed >= MAX_TXNS_PER_PASS) {
        remainingExpenses++;
        continue;
      }
      processed++;
      results.expenses.push(
        await splitExpenseTxn(realm, token, group.txnType, txnId, group.rows, accounts, {
          dryRun,
          closingDate,
          snapshot: snapshot(group.txnType, txnId),
        })
      );
    }

    const tally = (list: WriteOutcome[]) => ({
      split: list.filter((o) => o.outcome === "split").length,
      would_split: list.filter((o) => o.outcome === "would_split").length,
      skipped_closed: list.filter((o) => o.outcome === "skipped_closed").length,
      skipped_stale: list.filter((o) => o.outcome === "skipped_stale").length,
      skipped_already: list.filter((o) => o.outcome === "skipped_already").length,
      failed: list.filter((o) => o.outcome === "failed").length,
    });
    const summary = {
      dry_run: dryRun,
      side,
      window: { start, end },
      accounts: {
        payable: accounts.payable,
        recoverable: accounts.recoverable,
        pst_payable: accounts.pstPayable,
        created: accounts.created,
      },
      totals_planned: plan.totals,
      deposits: { planned_txns: depositPlans.size, ...tally(results.deposits) },
      expenses: { planned_txns: expensePlans.size, ...tally(results.expenses) },
      remaining: remainingDeposits + remainingExpenses,
      done: remainingDeposits + remainingExpenses === 0,
      failures: [...results.deposits, ...results.expenses]
        .filter((o) => o.outcome === "failed" || o.outcome === "skipped_stale")
        .slice(0, 20),
    };

    if (!dryRun) {
      try {
        await service.from("audit_log").insert({
          event_type: "gst_extraction_apply",
          user_id: user.id,
          request_payload: { client_link_id: clientLinkId, client_name: (client as any).client_name, ...summary } as any,
        } as any);
      } catch {
        /* summary logging is best-effort */
      }
    }

    return NextResponse.json(summary);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "apply failed" }, { status: 502 });
  }
}
