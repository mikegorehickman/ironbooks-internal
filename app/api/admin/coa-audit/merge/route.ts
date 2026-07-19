import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, fetchAllAccountsIncludingInactive, inactivateAccount, QBOReauthRequiredError } from "@/lib/qbo";
import { reclassAccountViaJournalEntry, repointItemsToAccount, detachSubAccounts, reactivateAccount } from "@/lib/coa-reclass-je";
import { computeCoaDrift, type DriftMasterRow } from "@/lib/coa-drift";

export const dynamic = "force-dynamic";
export const maxDuration = 300;


/**
 * POST /api/admin/coa-audit/merge — merge ONE non-master account into a
 * master account, from the audit view, after the bookkeeper approved it
 * (Mike, 2026-07-16: approve one at a time, then it updates all YTD
 * transactions). Reuses the executor's merge mechanics (move lines via
 * reclassifyTransactionLines, then inactivate the drained source).
 *
 * Scope = CURRENT CALENDAR YEAR TO DATE, including already-closed months
 * (Mike's call). We attempt every line; any QBO rejects (e.g. a closing-date
 * lock on a filed period) are reported as failures rather than hidden.
 *
 * Body: { client_link_id, source_account_id, target_account_id }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role)) {
    return NextResponse.json({ error: "Admin/lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "");
  const sourceId = String(body.source_account_id || "");
  const targetId = String(body.target_account_id || "");
  if (!clientLinkId || !sourceId || !targetId) {
    return NextResponse.json({ error: "client_link_id, source_account_id, target_account_id required" }, { status: 400 });
  }
  if (sourceId === targetId) {
    return NextResponse.json({ error: "Source and target can't be the same account" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, jurisdiction, industry, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink?.qbo_realm_id || !clientLink.is_active) {
    return NextResponse.json({ error: "Client not found / inactive / not QBO-connected" }, { status: 404 });
  }

  // Concurrency guard: never merge while a COA cleanup job is actively
  // rewriting this client's chart (same class of race the executor locks on).
  const { data: activeJob } = await service
    .from("coa_jobs")
    .select("id, status")
    .eq("client_link_id", clientLinkId)
    .eq("status", "executing")
    .limit(1)
    .maybeSingle();
  if (activeJob) {
    return NextResponse.json({ error: `A COA cleanup job is actively executing for this client — wait for it to finish before merging here.` }, { status: 409 });
  }

  const now = new Date();
  const ytdStart = `${now.getFullYear()}-01-01`;
  const ytdEnd = now.toISOString().slice(0, 10);

  try {
    const accessToken = await getValidToken(clientLink.id, service as any, "ironbooks/api/admin/coa-audit/merge");
    // Include INACTIVE accounts: a "(deleted)" account still carrying a P&L
    // balance (retired-without-drain by an old cleanup — Despres, 2026-07-18)
    // is a legitimate merge source. We reactivate it, drain it properly, and
    // re-retire it. Targets must be active.
    const accounts = await fetchAllAccountsIncludingInactive(clientLink.qbo_realm_id, accessToken);
    const byId = new Map(accounts.map((a) => [a.Id, a]));
    let source: any = byId.get(sourceId);
    const target: any = byId.get(targetId);
    if (!source) return NextResponse.json({ error: "Source account no longer exists" }, { status: 400 });
    if (!target || target.Active === false) return NextResponse.json({ error: "Target account no longer exists (or is inactive)" }, { status: 400 });
    let reactivated = false;
    if (source.Active === false) {
      source = await reactivateAccount({ realmId: clientLink.qbo_realm_id, accessToken, account: source });
      reactivated = true;
    }

    // Type-safety guard (defense in depth — the UI only offers compatible
    // targets): never merge a balance-sheet account (bank/card/AR/AP/asset/
    // loan) and never cross income↔expense↔equity families.
    const family = (t: string) => {
      const x = (t || "").toLowerCase();
      if (x === "income" || x === "other income") return "income";
      if (x === "expense" || x === "other expense" || x === "cost of goods sold") return "expense";
      if (x === "equity") return "equity";
      return "other";
    };
    const srcFam = family(source.AccountType);
    if (srcFam === "other") {
      return NextResponse.json({ error: `"${source.Name}" is a ${source.AccountType} account — this tool only merges P&L/equity accounts, not banks, receivables, assets, or loans.` }, { status: 400 });
    }
    if (srcFam !== family(target.AccountType)) {
      return NextResponse.json({ error: `Can't merge a ${source.AccountType} account into a ${target.AccountType} account — types must be compatible.` }, { status: 400 });
    }

    // QBO won't inactivate an account that still has sub-accounts. Detach the
    // source's children to the top level first so the now-childless parent can
    // be drained + retired; the children keep their balances and can be
    // merged/retyped on their own.
    const sourceHasChildren = accounts.some(
      (a) => String((a as any).ParentRef?.value || "") === sourceId && a.Active !== false
    );
    let childrenDetached = 0;
    if (sourceHasChildren) {
      const detach = await detachSubAccounts({
        realmId: clientLink.qbo_realm_id, accessToken, parentId: sourceId, accounts: accounts as any,
      });
      childrenDetached = detach.detached;
      if (detach.failures.length > 0) {
        return NextResponse.json({
          ok: false, method: "je_reclass", source: source.Name, target: target.Name,
          error: `Couldn't re-parent the sub-accounts of "${source.Name}": ${detach.failures.join("; ")}`,
        }, { status: 200 });
      }
    }

    // Move the source account's balance onto the target via reclassifying
    // journal entries (lib/coa-reclass-je). QBO can't merge via API and can't
    // reclass invoice/sales-receipt income by line, so a per-month JE is the
    // one mechanism that works for EVERY account type — income, expense, COGS —
    // and for cross-type moves. Then retire the drained source.
    const jeMemo = `SNAP COA merge: "${source.Name}" → "${target.Name}"`;
    const je = await reclassAccountViaJournalEntry({
      realmId: clientLink.qbo_realm_id,
      accessToken,
      source: source as any,
      target: target as any,
      startDate: ytdStart,
      endDate: ytdEnd,
      memo: jeMemo,
    });

    // Re-point any Items (products/services) that post to the source account
    // onto the target — otherwise QBO blocks inactivation ("used by a product
    // or service") and future invoices/bills keep landing on the retired
    // account. Failures fold into je.failures so we never retire a source that
    // still has live item links.
    const repoint = await repointItemsToAccount({
      realmId: clientLink.qbo_realm_id, accessToken,
      fromAccountId: sourceId, toAccountId: target.Id, toAccountName: target.Name,
    });
    for (const f of repoint.failures) je.failures.push(`re-point ${f}`);

    // Retire the drained source only if every month posted cleanly. An empty
    // source (no P&L activity in range) is also safe to inactivate.
    let inactivated = false;
    if (je.failures.length === 0) {
      try {
        const fresh = (await fetchAllAccounts(clientLink.qbo_realm_id, accessToken)).find((a) => a.Id === sourceId) as any;
        if (fresh && fresh.Active !== false) {
          await inactivateAccount(clientLink.qbo_realm_id, accessToken, sourceId, fresh.SyncToken, fresh);
        }
        inactivated = true;
      } catch (e: any) {
        je.failures.push(`inactivate source: ${e.message}`);
        inactivated = false;
      }
    }

    // Master rows → fresh drift for the in-place re-score.
    const industryRaw = ((clientLink as any).industry as string) || "painters";
    const jurisdiction = clientLink.jurisdiction || "US";
    let { data: masterRows } = await service
      .from("master_coa")
      .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
      .eq("industry", industryRaw).eq("jurisdiction", jurisdiction);
    if ((!masterRows || masterRows.length === 0) && industryRaw !== "painters") {
      ({ data: masterRows } = await service
        .from("master_coa")
        .select("account_name, qbo_account_type, qbo_account_subtype, parent_account_name, is_parent, is_required")
        .eq("industry", "painters").eq("jurisdiction", jurisdiction));
    }
    const after = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
    const drift = masterRows ? computeCoaDrift(after as any, masterRows as DriftMasterRow[]) : null;

    await service.from("audit_log").insert({
      event_type: "coa_audit_merge",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLink.id,
        client_name: clientLink.client_name,
        source: source.Name, target: target.Name,
        method: "je_reclass",
        reactivated_deleted_source: reactivated,
        ytd_start: ytdStart, ytd_end: ytdEnd,
        amount_moved: je.moved, jes_posted: je.jesPosted,
        months_with_activity: je.monthsWithActivity, found_in_report: je.foundInReport,
        items_repointed: repoint.repointed, children_detached: childrenDetached,
        failures: je.failures, inactivated,
      } as any,
    } as any);

    return NextResponse.json({
      ok: je.failures.length === 0,
      method: "je_reclass",
      source: source.Name, target: target.Name,
      amountMoved: je.moved, jesPosted: je.jesPosted, itemsRepointed: repoint.repointed, childrenDetached, reactivated,
      monthsWithActivity: je.monthsWithActivity, foundInReport: je.foundInReport,
      inactivated, failures: je.failures,
      linesMoved: je.jesPosted, unsupported: 0, // back-compat for the existing UI
      error: je.failures.length ? je.failures.join(" · ") : undefined,
      drift,
    });
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) return NextResponse.json({ error: "QBO reconnect required", reauth: true }, { status: 200 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
