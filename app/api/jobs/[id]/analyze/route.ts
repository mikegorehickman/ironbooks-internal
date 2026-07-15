import { computeRetypePlans } from "@/lib/coa-retype";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  fetchAllAccountsIncludingInactive, getValidToken, fetchTransactionCountsForAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { analyzeCOA, type MasterCOAEntry } from "@/lib/claude";
import { NextResponse } from "next/server";

// Allow up to 5 minutes for analysis - large client COAs (~200 accounts)
// require multiple sequential Claude calls, each taking 10-20s.
// Requires Vercel Pro plan or higher.
export const maxDuration = 300;

/**
 * POST /api/jobs/[id]/analyze
 *
 * 1. Fetches the client's current COA from QBO
 * 2. Loads the Ironbooks master COA for the jurisdiction
 * 3. Calls Claude to generate suggestions
 * 4. Persists everything in coa_jobs + coa_actions
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Use service client for the heavy work (bypasses RLS for system operations)
  const service = createServiceSupabase();

  // 1. Load the job + client info
  const { data: job, error: jobErr } = await service
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();

  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const clientLink = (job as any).client_links;
  if (!clientLink) {
    return NextResponse.json({ error: "Client link missing" }, { status: 400 });
  }

  try {
    // 2. Get valid QBO token (auto-refreshes)
    const accessToken = await getValidToken(clientLink.id, service as any);

    // 3. Fetch QBO COA + transaction counts IN PARALLEL. These are two
    //    independent QBO calls; the previous sequential pattern wasted
    //    several seconds for no reason. Both must succeed for analyze to
    //    proceed, so a single Promise.all is fine.
    const isPnLAccountType = (t: string | undefined): boolean => {
      if (!t) return false;
      const norm = t.toLowerCase().replace(/\s+/g, "");
      return (
        norm === "income" ||
        norm === "otherincome" ||
        norm === "expense" ||
        norm === "otherexpense" ||
        norm === "costofgoodssold"
      );
    };

    const [allQboAccountsIncludingInactive, txCounts] = await Promise.all([
      fetchAllAccountsIncludingInactive(clientLink.qbo_realm_id, accessToken),
      fetchTransactionCountsForAllAccounts(clientLink.qbo_realm_id, accessToken),
    ]);
    // Suggestions operate on ACTIVE accounts only, but INACTIVE names are
    // still reserved by QBO (creating them fails with 6240 Duplicate Name) —
    // so they count as "existing" for the missing-accounts computation.
    const allQboAccounts = allQboAccountsIncludingInactive.filter((a) => a.Active !== false);
    const inactiveReservedNames = allQboAccountsIncludingInactive
      .filter((a) => a.Active === false)
      .map((a) => a.Name);

    // 3a. Restrict cleanup to P&L accounts only.
    //   Balance Sheet accounts (AR/AP, banks, credit cards, fixed assets,
    //   equity, liabilities) shouldn't be renamed/deleted/merged by this tool.
    //   Their structure is determined by QBO mechanics, not the master COA.
    const qboAccounts = allQboAccounts.filter((a) => isPnLAccountType(a.AccountType));

    // Decorate accounts with transaction_count so Claude sees it in the prompt
    const accountsWithTxCounts = qboAccounts.map((a: any) => ({
      ...a,
      transaction_count: txCounts.get(a.Id) ?? 0,
    }));

    // 4. Load master COA for the client's jurisdiction + industry.
    //    Industry is REQUIRED — silent fallback to "painters" caused
    //    chimney sweepers (and others) to get the painter COA without
    //    anyone noticing. Reject the job clearly instead.
    const industry = (clientLink as any).industry as string | null;
    if (!industry) {
      await service.from("coa_jobs").update({
        status: "failed",
        error_message: `Client has no industry set. Set the industry on the client record before running cleanup so the right master COA template loads.`,
      }).eq("id", jobId);
      return NextResponse.json(
        { error: "Client industry not set — pick one on the client record first." },
        { status: 400 }
      );
    }

    const industryWarnings: string[] = [];

    let { data: masterRows } = await service
      .from("master_coa")
      .select("*")
      .eq("jurisdiction", clientLink.jurisdiction)
      .eq("industry", industry)
      .order("sort_order");

    // Soft fallback only when the requested industry genuinely has zero rows
    // in this jurisdiction. Surface this as a warning in the job so the
    // bookkeeper SEES the fallback instead of getting silent painter content.
    if ((masterRows || []).length === 0) {
      industryWarnings.push(
        `No master_coa rows seeded for industry="${industry}" / jurisdiction="${clientLink.jurisdiction}". ` +
        `Falling back to painters baseline — recommendations may reference painter-specific accounts. ` +
        `Customize the ${industry} template in /templates to make this client-specific.`
      );
      console.warn(
        `[analyze] industry fallback fired: ${industry}/${clientLink.jurisdiction} → painters baseline`
      );
      const fb = await service
        .from("master_coa")
        .select("*")
        .eq("jurisdiction", clientLink.jurisdiction)
        .eq("industry", "painters")
        .order("sort_order");
      masterRows = fb.data;
    }
    if ((masterRows || []).length === 0) {
      industryWarnings.push(
        `Painters baseline ALSO empty for jurisdiction="${clientLink.jurisdiction}". ` +
        `Loading ANY rows for this jurisdiction — recommendations will be unreliable.`
      );
      const fb = await service
        .from("master_coa")
        .select("*")
        .eq("jurisdiction", clientLink.jurisdiction)
        .order("sort_order");
      masterRows = fb.data;
    }

    const masterCOA: MasterCOAEntry[] = (masterRows || [])
      .filter((m) => isPnLAccountType(m.qbo_account_type))
      .map((m) => ({
        account_name: m.account_name,
        parent_account_name: m.parent_account_name,
        is_parent: m.is_parent ?? false,
        qbo_account_type: m.qbo_account_type,
        qbo_account_subtype: m.qbo_account_subtype,
        section: m.section,
        notes: m.notes || "",
        is_required: m.is_required ?? false,
        tax_treatment: m.tax_treatment,
      }));

    // 5. Run Claude analysis
    const analysis = await analyzeCOA({
      clientName: clientLink.client_name,
      jurisdiction: clientLink.jurisdiction,
      stateProvince: clientLink.state_province || "",
      clientAccounts: accountsWithTxCounts,
      masterCOA,
      reservedNames: inactiveReservedNames,
    });

    // Prepend industry-fallback warnings so they appear at the top of the
    // warnings list in the cleanup review UI — bookkeeper sees them first.
    if (industryWarnings.length > 0) {
      analysis.warnings = [...industryWarnings, ...analysis.warnings];
    }

    // 5.5. Rename→merge collision resolution (Mike, 2026-07-15).
    //
    // QBO can't hold two accounts with the same name, so when several accounts
    // target the same name — or a rename targets a name that already exists in
    // QBO — we resolve it INLINE (no more flag + post-cleanup "merge card"
    // detour) so the review dropdown opens on the real recommendation:
    // exactly ONE account keeps "rename" (the winner), every OTHER becomes
    // "merge" into that target.
    //   - Scenario 1 (target already exists in QBO): ALL sources merge into it,
    //     no rename winner needed.
    //   - Scenario 2 (new consolidation): the highest-transaction account keeps
    //     the rename (it creates the target name); the rest merge into it.
    //
    // `forced` maps qbo_account_id → the action that overrides the analyzer's
    // original "rename". `mergedAccountIds` is the set demoted to merge.
    const forced = new Map<string, { action: "merge"; target: string; targetId: string | null }>();
    const mergedAccountIds = new Set<string>();

    // Build a lookup of QBO accounts by case-folded name for Scenario 1 detection
    const qboByName = new Map<string, any>();
    for (const acc of qboAccounts) {
      if (acc.Active !== false && acc.Name) {
        qboByName.set(acc.Name.toLowerCase().trim(), acc);
      }
    }

    // Group rename suggestions by target name to find Scenario 2 (multi-source consolidation)
    const renameSuggestions = analysis.suggestions.filter(
      (s: any) => s.action === "rename" && s.target_master_account && s.qbo_account_id
    );
    const byTarget = new Map<string, typeof renameSuggestions>();
    for (const s of renameSuggestions) {
      const key = (s.target_master_account as string).toLowerCase().trim();
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.push(s);
    }

    for (const [targetKey, group] of byTarget.entries()) {
      const targetName = group[0].target_master_account as string;
      const existingTargetInQbo = qboByName.get(targetKey);

      // Skip if the existing QBO account IS one of the rename sources (i.e., we're
      // just renaming that same account to itself or its case-variant — not a merge).
      const sourceIds = new Set(group.map((g: any) => g.qbo_account_id));
      const existingIsItselfASource = existingTargetInQbo && sourceIds.has(existingTargetInQbo.Id);

      const isScenario1 = existingTargetInQbo && !existingIsItselfASource;
      const isScenario2 = group.length > 1 && !isScenario1;

      if (!isScenario1 && !isScenario2) continue; // lone rename to a brand-new name — no collision

      if (isScenario1) {
        // Target already exists in QBO → every source merges into it (capture
        // the stable target id so the executor merges by id, not fuzzy name).
        for (const s of group) {
          forced.set(s.qbo_account_id as string, {
            action: "merge",
            target: targetName,
            targetId: existingTargetInQbo.Id,
          });
          mergedAccountIds.add(s.qbo_account_id as string);
        }
      } else {
        // New consolidation → the highest-transaction account keeps its rename
        // (creating the target name); every other account merges into it. The
        // merge resolves by name at execute time, after the winner's rename.
        const winnerId = [...group].sort(
          (a: any, b: any) =>
            (txCounts.get(b.qbo_account_id) ?? 0) - (txCounts.get(a.qbo_account_id) ?? 0) ||
            Number(a.qbo_account_id) - Number(b.qbo_account_id)
        )[0].qbo_account_id as string;
        for (const s of group) {
          if (s.qbo_account_id === winnerId) continue; // stays a rename
          forced.set(s.qbo_account_id as string, {
            action: "merge",
            target: targetName,
            targetId: null,
          });
          mergedAccountIds.add(s.qbo_account_id as string);
        }
      }
    }


    await service.from("coa_jobs").update({
      status: "in_review",
      current_coa_snapshot: qboAccounts as any, // P&L-only — BS accounts excluded from cleanup scope
      snapshot_pulled_at: new Date().toISOString(),
      ai_suggestions: analysis as any,
      ai_model_used: "claude-opus-4-7",
      ai_completed_at: new Date().toISOString(),
      // Collision losers are now first-class "merge" actions, not flags — so
      // rename count drops by the demoted set and flagged count is flags only.
      accounts_to_rename:
        analysis.suggestions.filter(s => s.action === "rename").length -
        mergedAccountIds.size,
      accounts_to_delete: analysis.suggestions.filter(s => s.action === "delete").length,
      accounts_flagged: analysis.suggestions.filter(s => s.action === "flag").length,
      accounts_to_create: analysis.missing_required_accounts.length,
      flagged_for_lisa: analysis.suggestions.some(s => s.action === "flag"),
      // Collisions are handled inline as merge ACTIONS now — the old
      // post-cleanup "merge card" list is retired (kept empty for readers).
      merge_candidates: [] as any,
    }).eq("id", jobId);

    // 7. Create individual action rows.
    // Collision losers (from the pass above) are written as first-class "merge"
    // actions — so the review dropdown opens on the real recommendation
    // (rename for the winner, "Merge into …" for the rest) instead of "flag".
    const actions = analysis.suggestions.map((s, idx) => {
      const override = s.qbo_account_id ? forced.get(s.qbo_account_id) : undefined;
      // If the target already exists in QBO at analyze-time, capture its
      // stable QBO ID so the executor doesn't have to re-resolve by name
      // (which can collide on subaccounts and post-rename moves — caused
      // the "we picked QuickBooks Payroll but it landed in Software" bug).
      const targetInQbo = s.target_master_account
        ? qboByName.get(String(s.target_master_account).toLowerCase().trim())
        : null;
      const effectiveTarget = override ? override.target : (s.target_master_account || null);
      const effectiveTargetId = override
        ? (override.targetId ?? (targetInQbo ? targetInQbo.Id : null))
        : (targetInQbo ? targetInQbo.Id : null);
      return {
        job_id: jobId,
        qbo_account_id: s.qbo_account_id,
        current_name: s.current_name,
        action: override ? override.action : s.action,
        new_name: effectiveTarget,
        new_qbo_account_id: effectiveTargetId,
        ai_confidence: s.confidence,
        ai_reasoning: override
          ? `${s.reasoning || ""} — auto-set to Merge: "${effectiveTarget}" is already being renamed/created by another account, and QBO can't hold two accounts with the same name.`.trim()
          : s.reasoning,
        ai_suggested_target: s.target_master_account || null,
        flagged_reason: s.flag_reason || null,
        transaction_count: s.qbo_account_id ? (txCounts.get(s.qbo_account_id) ?? 0) : 0,
        sort_order: idx,
      };
    });

    // Add "create" actions for every missing standard master account (full
    // chart applied to every client per the JP audit — not just required ones).
    const missingActions = analysis.missing_required_accounts.map((name, idx) => {
      const masterEntry = masterCOA.find(m => m.account_name === name);
      return {
        job_id: jobId,
        action: "create" as const,
        new_name: name,
        new_type: masterEntry?.qbo_account_type,
        new_subtype: masterEntry?.qbo_account_subtype,
        new_parent_name: masterEntry?.parent_account_name,
        ai_confidence: 1.0,
        ai_reasoning: "Standard master account missing from client COA",
        sort_order: actions.length + idx,
      };
    });

    // Replace existing UNEXECUTED suggestions for this job before inserting
    // the fresh batch. Without this delete, every re-analyze stacks rows on
    // top of the previous run and the bookkeeper sees the same account 3x
    // ("Wages" / "Cost of labor - COGS" / "Direct Payroll Taxes" triplicated
    // — see screenshot from Cody Ruane's review on June 3).
    //
    // We DO NOT delete executed rows — those represent QBO writes that
    // already landed; deleting would lose the audit trail and re-running
    // analyze could re-propose work that's already done.
    //
    // `.is("executed", null)` covers the "not yet attempted" rows;
    // `.eq("executed", false)` covers the rows that explicitly failed
    // (so a retry can replace them with fresh AI suggestions).
    const { error: delErr } = await service
      .from("coa_actions")
      .delete()
      .eq("job_id", jobId)
      .or("executed.is.null,executed.eq.false");
    if (delErr) {
      console.warn(
        `[coa-analyze ${jobId}] couldn't clear stale actions before re-analyze: ${delErr.message}`
      );
      // Don't bail — better to ship duplicates than to fail analyze entirely.
      // The bookkeeper can manually dismiss the older copies. Logged for triage.
    }

    await service.from("coa_actions").insert([...actions, ...missingActions] as any);

    // RETYPE ACTIONS (JP audit): accounts whose name matches the standard
    // chart (directly, or via the rename the analyzer just proposed) but
    // whose AccountType/AccountSubType is wrong — e.g. "Salaries & Payroll"
    // typed Other Expense, which pushes payroll below the line on the P&L.
    // Inserted SEPARATELY and fail-soft: until migration 119 adds 'retype'
    // to the coa_action enum this insert fails harmlessly and the rest of
    // the analysis is unaffected.
    const renameTargets = new Map<string, string>(
      analysis.suggestions
        .filter(s => s.action === "rename" && s.qbo_account_id && s.target_master_account && !mergedAccountIds.has(s.qbo_account_id))
        .map(s => [String(s.qbo_account_id), String(s.target_master_account)])
    );
    const retypePlans = computeRetypePlans({
      masterRows: masterCOA.map(m => ({
        account_name: m.account_name,
        qbo_account_type: m.qbo_account_type,
        qbo_account_subtype: m.qbo_account_subtype ?? null,
      })),
      clientAccounts: qboAccounts.map((a: any) => ({
        Id: a.Id, Name: a.Name, AccountType: a.AccountType, AccountSubType: a.AccountSubType,
      })),
      renameTargets,
    });
    if (retypePlans.length > 0) {
      const retypeActions = retypePlans.map((r, idx) => ({
        job_id: jobId,
        qbo_account_id: r.qbo_account_id,
        current_name: r.current_name,
        current_type: r.current_type,
        current_subtype: r.current_subtype,
        action: "retype" as any,
        new_type: r.new_type,
        new_subtype: r.new_subtype,
        ai_confidence: 1.0,
        ai_reasoning: r.reason,
        sort_order: actions.length + missingActions.length + idx,
      }));
      const { error: retypeErr } = await service.from("coa_actions").insert(retypeActions as any);
      if (retypeErr) {
        console.warn(`[coa-analyze ${jobId}] retype actions not inserted (migration 119 applied?): ${retypeErr.message}`);
      }
    }

    return NextResponse.json({
      success: true,
      job_id: jobId,
      stats: {
        client_accounts: qboAccounts.length,
        suggestions: analysis.suggestions.length,
        missing_accounts: analysis.missing_required_accounts.length,
        warnings: analysis.warnings.length + industryWarnings.length,
      },
      summary: analysis.summary,
      industry_warnings: industryWarnings,
    });
  } catch (error: any) {
    // Capture full stack so bare ReferenceErrors like "accountType is not defined"
    // point us at the actual source line instead of forcing us to grep blindly.
    const stack = error?.stack || "(no stack)";
    console.error(`[analyze ${jobId}] FATAL: ${error?.message || error}\n${stack}`);

    await service.from("coa_jobs").update({
      status: "failed",
      error_message: `${error?.message || error} | at ${stack.split("\n")[1]?.trim() || "(unknown)"}`,
    }).eq("id", jobId);

    return qboErrorResponse(error);
  }
}
