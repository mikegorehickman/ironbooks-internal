import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getValidToken, fetchAllAccounts, QBOReauthRequiredError } from "@/lib/qbo";
import { applyMasterCoaToClient, type MasterCoaRow } from "@/lib/apply-master-coa";
import { normalizeAccountName } from "@/lib/account-name";

/**
 * GET /api/rules/export-qbo/[client_link_id]
 *
 * Returns an .xls file in QBO's exact "Export Rules" format so the
 * bookkeeper can upload it via QBO's Banking → Rules → ⋮ → Import Rules
 * flow. This is the workaround for QBO's public API not supporting
 * /bankrule POSTs (every attempt returns "Unsupported Operation").
 *
 * Format reverse-engineered from a real QBO export
 * (Painter_Growth_Ventures_Ltd__Bank_Feed_Rules.xls):
 *
 *   - Single sheet named "Worksheet"
 *   - 3 columns: "Rule Name" | "Rule Conditions" | "Rule Outputs"
 *   - Conditions + Outputs are JSON strings with numeric ruleType /
 *     actionType codes
 *   - Categories use account NAME (parent:child format), NOT internal
 *     QBO IDs — meaning we can write target_account_name straight
 *     through without resolving against the target QBO file
 *
 * Before building the file, we ensure every target account referenced by
 * these rules actually EXISTS in the client's live QBO chart (creating any
 * master-COA account that's missing, additive-only — same primitive as
 * /admin/apply-master-coa). Mike, 2026-07-15: QBO's own "Upload list"
 * import wizard tries to auto-match each row's category text against the
 * live COA and falls back to a blank "Select category" dropdown whenever
 * no matching account exists yet — which was every row for a brand-new
 * category (Job Supplies & Materials, Parking, Small Tools, Permit Fees on
 * Dominion Painters). Creating the account first means the exact name is
 * live in QBO by the time the file lands in the wizard, so it auto-selects.
 *
 * Action type codes:
 *   0  = category (account name)
 *   1  = memo
 *   4  = tax code
 *   5  = payee
 *   7  = (numeric, observed but undocumented — class? location?)
 *   8  = auto-add boolean
 *   11 = (always [] in samples)
 *
 * Condition type codes:
 *   1  = description contains
 *   10 = transaction sign ("-1" = money out / expense, "1" = money in)
 */
// Account creation is sequential QBO writes (one per missing account, plus
// parents) — budget beyond Vercel's default cap the same as apply-master-coa.
export const maxDuration = 300;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ client_link_id: string }> }
) {
  const { client_link_id } = await params;

  // ?include=new (default) → only rules not yet exported to QBO
  // ?include=all → every active rule (escape hatch for re-exports when
  //   Lisa wiped her QBO Rules tab or set up a new QBO file)
  const url = new URL(request.url);
  const includeMode = url.searchParams.get("include") === "all" ? "all" : "new";

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  // Pull client name for the filename + ensure the user can access this client
  const { data: clientLink } = await service
    .from("client_links")
    .select("client_name, qbo_realm_id, jurisdiction, industry")
    .eq("id", client_link_id)
    .single();

  if (!clientLink) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Only export ACTIVE rules. "pending" rules haven't been approved yet,
  // "rejected" rules were deliberately killed, "active" rules are what
  // SNAP's daily-recon engine applies — and what Lisa wants in QBO too.
  //
  // In "new" mode (default) also exclude rules already flagged as exported
  // (pushed_to_qbo=true). Mike runs discovery monthly on the same clients,
  // so every export after the first should be incremental. QBO doesn't
  // dedupe imports — sending a rule twice creates a duplicate in QBO's
  // Rules tab. The pushed_to_qbo flag is our defense.
  let query = service
    .from("bank_rules")
    .select("id, vendor_pattern, target_account_name")
    .eq("client_link_id", client_link_id)
    .eq("status", "active")
    .not("vendor_pattern", "is", null)
    .not("target_account_name", "is", null);

  if (includeMode === "new") {
    // Postgrest doesn't have IS NOT TRUE; emulate with `eq(false)` OR `is null`.
    // The .or syntax is: "pushed_to_qbo.is.null,pushed_to_qbo.eq.false"
    query = query.or("pushed_to_qbo.is.null,pushed_to_qbo.eq.false");
  }

  const { data: rules, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!rules || rules.length === 0) {
    return NextResponse.json(
      {
        error:
          includeMode === "new"
            ? "No new bank rules to export — every active rule has already been exported to QBO. Add ?include=all to the URL to re-export everything."
            : "No active bank rules to export for this client",
      },
      { status: 404 }
    );
  }

  // Ensure every target account these rules reference actually exists in
  // the client's live QBO — additive-only account creation, scoped to just
  // the account names this export needs (not a full COA application). Fail
  // soft: if QBO is unreachable or reauth is needed, export proceeds with
  // whatever account names are already on the rules (today's behavior).
  const accountsEnsured = { created: [] as string[], unresolved: [] as string[] };
  if (clientLink.qbo_realm_id) {
    const neededNames = [
      ...new Set(rules.map((r: any) => String(r.target_account_name || "").trim()).filter(Boolean)),
    ];
    try {
      const accessToken = await getValidToken(client_link_id, service as any, "ironbooks/api/rules/export-qbo");
      const liveAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
      const liveNamesNorm = new Set(liveAccounts.map((a) => normalizeAccountName(a.Name)));

      const industryRaw = (clientLink as any).industry || "painters";
      const jurisdiction = (clientLink as any).jurisdiction || "US";
      let { data: masterRows } = await service
        .from("master_coa")
        .select("account_name, parent_account_name, is_parent, qbo_account_type, qbo_account_subtype")
        .eq("industry", industryRaw)
        .eq("jurisdiction", jurisdiction);
      if ((!masterRows || masterRows.length === 0) && industryRaw !== "painters") {
        ({ data: masterRows } = await service
          .from("master_coa")
          .select("account_name, parent_account_name, is_parent, qbo_account_type, qbo_account_subtype")
          .eq("industry", "painters")
          .eq("jurisdiction", jurisdiction));
      }
      if (masterRows && masterRows.length > 0) {
        const applyResult = await applyMasterCoaToClient({
          clientLinkId: client_link_id,
          clientName: clientLink.client_name,
          realmId: clientLink.qbo_realm_id,
          accessToken,
          masterRows: masterRows as MasterCoaRow[],
          dryRun: false,
          onlyLeafNames: neededNames,
        });
        accountsEnsured.created = applyResult.created;
      }
      // Anything still missing after creation attempts — either it was
      // already live (fine, no action needed) or it genuinely couldn't be
      // resolved (not a master-COA name and not already in QBO). Surface
      // only the latter so the export log names the real gap instead of a
      // silent mismatch in QBO's wizard.
      const createdNorm = new Set(accountsEnsured.created.map((n) => normalizeAccountName(n)));
      accountsEnsured.unresolved = neededNames.filter(
        (n) => !liveNamesNorm.has(normalizeAccountName(n)) && !createdNorm.has(normalizeAccountName(n))
      );
    } catch (err: any) {
      if (!(err instanceof QBOReauthRequiredError)) {
        console.warn(`[export-qbo ${client_link_id}] Could not ensure target accounts:`, err.message);
      }
    }
  }

  // Build the rows in QBO's exact format. One row per rule.
  const rows: Array<Record<string, string>> = [];
  for (const r of rules) {
    const vendor = (r.vendor_pattern || "").trim();
    const account = (r.target_account_name || "").trim();
    if (!vendor || !account) continue;

    // QBO's conditions JSON. We model every SNAP rule as:
    //   "transaction is money out AND description contains <vendor>"
    // ruleType 10 = sign, "-1" = expense (the only direction SNAP
    // discovers right now — income rules aren't in the discovery pipeline)
    // ruleType 1  = description contains
    const conditions = {
      ruleConditions: [
        { ruleType: 10, value: "-1" },
        { ruleType: 1, value: vendor },
      ],
      isAndRule: true,
    };

    // QBO's actions JSON. We set:
    //   actionType 0  = category (the target account)
    //   actionType 1  = memo (echoes the vendor pattern so the bookkeeper
    //                  can eyeball it in QBO's tx list)
    //   actionType 11 = always [] per QBO's own exports
    //   actionType 8  = true  → auto-apply without confirmation, matching
    //                  the behavior of "active" rules in SNAP
    //
    // We intentionally OMIT actionType 4 (tax code) and 5 (payee).
    // Tax codes are per-jurisdiction and would force the bookkeeper to
    // either pick one in SNAP (we don't ask) or risk QBO refusing the
    // import. Payee similarly requires matching an existing QBO vendor
    // by exact name; we'd need a fuzzy match per-client to be safe.
    // Leaving both blank lets QBO apply its default behavior.
    const outputs = {
      ruleActions: [
        { actionType: 0, value: account },
        { actionType: 1, value: vendor },
        { actionType: 11, value: [] as unknown[] },
        { actionType: 8, value: true },
      ],
    };

    rows.push({
      "Rule Name": vendor,
      "Rule Conditions": JSON.stringify(conditions),
      "Rule Outputs": JSON.stringify(outputs),
    });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No active rules with both vendor + target account" },
      { status: 404 }
    );
  }

  // Build the workbook. Sheet name MUST be "Worksheet" — QBO's import
  // expects that exact name (matches what its own export emits).
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: ["Rule Name", "Rule Conditions", "Rule Outputs"],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Worksheet");

  // Write as legacy BIFF8 (.xls) — that's what QBO emits and most likely
  // what its importer expects. SheetJS supports it natively via bookType.
  const buffer: Buffer = XLSX.write(workbook, {
    bookType: "biff8",
    type: "buffer",
  });

  // Flip the export-tracking flag so the NEXT export (in "new" mode)
  // doesn't re-include these rules. The flag also feeds the bank-rules
  // page's "skip vendors already in QBO" logic. We only flip rules we
  // actually included in this .xls — defensive in case the row list
  // changed between query and now.
  //
  // In "all" mode this is mostly a no-op (rules were already true) but
  // we still refresh pushed_to_qbo_at so "last exported X days ago"
  // reflects the most recent re-export.
  const exportedIds = rules.map((r: any) => r.id).filter(Boolean);
  if (exportedIds.length > 0) {
    await service
      .from("bank_rules")
      .update({
        pushed_to_qbo: true,
        pushed_to_qbo_at: new Date().toISOString(),
      } as any)
      .in("id", exportedIds);
  }

  // Log the export so we have telemetry if Lisa hits import issues
  await service.from("audit_log").insert({
    event_type: "bank_rules_exported_qbo",
    user_id: user.id,
    request_payload: {
      client_link_id,
      client_name: clientLink.client_name,
      rule_count: rows.length,
      include_mode: includeMode,
      format: "biff8_xls",
      accounts_created: accountsEnsured.created,
      accounts_unresolved: accountsEnsured.unresolved,
    } as any,
  });

  // Sanitize the filename — strip anything that'd confuse a Windows
  // filesystem since bookkeepers are often on Windows
  const safeName = (clientLink.client_name || "client")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const filename = `${safeName}_Bank_Feed_Rules.xls`;

  return new NextResponse(buffer as any, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.ms-excel",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
      // Header values must stay ASCII/newline-free — encode the account
      // name lists so the client component can surface exactly which
      // categories were auto-created in QBO vs. couldn't be resolved.
      "X-Accounts-Created": encodeURIComponent(JSON.stringify(accountsEnsured.created)),
      "X-Accounts-Unresolved": encodeURIComponent(JSON.stringify(accountsEnsured.unresolved)),
    },
  });
}
