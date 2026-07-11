import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken, fetchTransactionCountsForAllAccounts, qboErrorResponse } from "@/lib/qbo";
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

    const [allQboAccounts, txCounts] = await Promise.all([
      fetchAllAccounts(clientLink.qbo_realm_id, accessToken),
      fetchTransactionCountsForAllAccounts(clientLink.qbo_realm_id, accessToken),
    ]);

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
    });

    // Prepend industry-fallback warnings so they appear at the top of the
    // warnings list in the cleanup review UI — bookkeeper sees them first.
    if (industryWarnings.length > 0) {
      analysis.warnings = [...industryWarnings, ...analysis.warnings];
    }

    // 5.5. Detect merge candidates.
    //
    // A merge candidate exists when:
    //   - Multiple rename actions point to the same target_master_account (Scenario 2: new consolidation)
    //   - OR a single rename action targets a name that already exists in client's QBO (Scenario 1: existing target)
    //
    // For each detected merge, we suppress the corresponding rename actions from
    // the auto-execute flow (they get filtered out below) and present an
    // interactive merge card after cleanup completes. Lisa decides per-merge.
    interface MergeCandidate {
      id: string;
      type: "existing_target" | "new_consolidation";
      target_name: string;
      target_account_id: string | null;
      source_accounts: Array<{
        id: string;
        name: string;
        transaction_count: number;
        balance: number;
      }>;
      recommended_winner_id: string | null;
      status: "pending" | "in_progress" | "complete" | "failed" | "ignored";
      error_message: string | null;
      completed_at: string | null;
      user_choice: any;
    }

    const mergeCandidates: MergeCandidate[] = [];
    const suppressedActionAccountIds = new Set<string>();

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

    let mergeIdCounter = 1;
    for (const [targetKey, group] of byTarget.entries()) {
      const targetName = group[0].target_master_account as string;
      const existingTargetInQbo = qboByName.get(targetKey);

      // Skip if the existing QBO account IS one of the rename sources (i.e., we're
      // just renaming that same account to itself or its case-variant — not a merge).
      const sourceIds = new Set(group.map((g: any) => g.qbo_account_id));
      const existingIsItselfASource = existingTargetInQbo && sourceIds.has(existingTargetInQbo.Id);

      const isScenario1 = existingTargetInQbo && !existingIsItselfASource;
      const isScenario2 = group.length > 1 && !isScenario1;

      if (!isScenario1 && !isScenario2) continue;

      // Build source rows with tx counts + balances from QBO snapshot
      const sourceById = new Map(qboAccounts.map((a: any) => [a.Id, a]));
      const sources = group.map((g: any) => {
        const acc: any = sourceById.get(g.qbo_account_id) || {};
        return {
          id: g.qbo_account_id as string,
          name: g.current_name as string,
          transaction_count: txCounts.get(g.qbo_account_id) ?? 0,
          balance: Number(acc.CurrentBalance ?? 0),
        };
      });

      // Pick winner: account with most transactions; tie-break by lowest id
      const recommendedWinner = isScenario1
        ? null
        : [...sources].sort(
            (a, b) =>
              b.transaction_count - a.transaction_count ||
              Number(a.id) - Number(b.id)
          )[0].id;

      mergeCandidates.push({
        id: `merge_${mergeIdCounter++}`,
        type: isScenario1 ? "existing_target" : "new_consolidation",
        target_name: targetName,
        target_account_id: isScenario1 ? existingTargetInQbo.Id : null,
        source_accounts: sources,
        recommended_winner_id: recommendedWinner,
        status: "pending",
        error_message: null,
        completed_at: null,
        user_choice: null,
      });

      // Mark these source account renames as suppressed from auto-execute
      for (const s of group) {
        suppressedActionAccountIds.add(s.qbo_account_id as string);
      }
    }


    await service.from("coa_jobs").update({
      status: "in_review",
      current_coa_snapshot: qboAccounts as any, // P&L-only — BS accounts excluded from cleanup scope
      snapshot_pulled_at: new Date().toISOString(),
      ai_suggestions: analysis as any,
      ai_model_used: "claude-opus-4-7",
      ai_completed_at: new Date().toISOString(),
      accounts_to_rename:
        analysis.suggestions.filter(s => s.action === "rename").length -
        suppressedActionAccountIds.size,
      accounts_to_delete: analysis.suggestions.filter(s => s.action === "delete").length,
      accounts_flagged:
        analysis.suggestions.filter(s => s.action === "flag").length +
        suppressedActionAccountIds.size,
      accounts_to_create: analysis.missing_required_accounts.length,
      flagged_for_lisa:
        analysis.suggestions.some(s => s.action === "flag") || mergeCandidates.length > 0,
      merge_candidates: mergeCandidates as any,
    }).eq("id", jobId);

    // 7. Create individual action rows.
    // Suppressed actions (those participating in a merge candidate) become "flag"
    // instead of "rename" so the executor skips them — merge happens via the
    // separate per-card workflow on the live execution / report screen.
    const actions = analysis.suggestions.map((s, idx) => {
      const isSuppressed = s.qbo_account_id && suppressedActionAccountIds.has(s.qbo_account_id);
      // If the target already exists in QBO at analyze-time, capture its
      // stable QBO ID so the executor doesn't have to re-resolve by name
      // (which can collide on subaccounts and post-rename moves — caused
      // the "we picked QuickBooks Payroll but it landed in Software" bug).
      const targetInQbo = s.target_master_account
        ? qboByName.get(String(s.target_master_account).toLowerCase().trim())
        : null;
      return {
        job_id: jobId,
        qbo_account_id: s.qbo_account_id,
        current_name: s.current_name,
        action: isSuppressed ? "flag" : s.action,
        new_name: s.target_master_account || null,
        new_qbo_account_id: targetInQbo ? targetInQbo.Id : null,
        ai_confidence: s.confidence,
        ai_reasoning: s.reasoning,
        ai_suggested_target: s.target_master_account || null,
        flagged_reason: isSuppressed
          ? `Part of a merge into "${s.target_master_account}" — handled via Manual Cleanup Report.`
          : (s.flag_reason || null),
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
