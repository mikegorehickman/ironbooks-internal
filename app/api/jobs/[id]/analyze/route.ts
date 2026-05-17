import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken, fetchTransactionCountsForAllAccounts } from "@/lib/qbo";
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

    // 3. Fetch QBO COA
    const allQboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);

    // 3a. Restrict cleanup to P&L accounts only.
    //   Balance Sheet accounts (AR/AP, banks, credit cards, fixed assets,
    //   equity, liabilities) shouldn't be renamed/deleted/merged by this tool.
    //   Their structure is determined by QBO mechanics, not the master COA.
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
    const qboAccounts = allQboAccounts.filter((a) => isPnLAccountType(a.AccountType));

    // 3b. Fetch transaction counts for all accounts.
    // CRITICAL for production: Claude must know which accounts have transactions
    // so it suggests FLAG instead of DELETE. Otherwise it suggests deletes that
    // QBO will reject at runtime.
    const txCounts = await fetchTransactionCountsForAllAccounts(
      clientLink.qbo_realm_id, accessToken
    );

    // Decorate accounts with transaction_count so Claude sees it in the prompt
    const accountsWithTxCounts = qboAccounts.map((a: any) => ({
      ...a,
      transaction_count: txCounts.get(a.Id) ?? 0,
    }));

    // 4. Load master COA for the client's jurisdiction + industry
    //    Falls back to no-industry filter if Migration 7 hasn't run yet.
    const industry = (clientLink as any).industry || "painters";
    let { data: masterRows } = await service
      .from("master_coa")
      .select("*")
      .eq("jurisdiction", clientLink.jurisdiction)
      .eq("industry", industry)
      .order("sort_order");
    // Fallback: painters baseline if this industry isn't seeded; then no-filter.
    // Post-Migration 13, every supported industry should have rows — log if we
    // ever hit this so it's obvious which industry needs seeding.
    if ((masterRows || []).length === 0 && industry !== "painters") {
      console.warn(
        `[analyze] No master_coa rows for industry="${industry}" jurisdiction="${clientLink.jurisdiction}" — falling back to painters template`
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
      return {
        job_id: jobId,
        qbo_account_id: s.qbo_account_id,
        current_name: s.current_name,
        action: isSuppressed ? "flag" : s.action,
        new_name: s.target_master_account || null,
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

    // Add "create" actions for missing required accounts
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
        ai_reasoning: "Required master account missing from client COA",
        sort_order: actions.length + idx,
      };
    });

    await service.from("coa_actions").insert([...actions, ...missingActions] as any);

    return NextResponse.json({
      success: true,
      job_id: jobId,
      stats: {
        client_accounts: qboAccounts.length,
        suggestions: analysis.suggestions.length,
        missing_accounts: analysis.missing_required_accounts.length,
        warnings: analysis.warnings.length,
      },
      summary: analysis.summary,
    });
  } catch (error: any) {
    console.error("Analysis failed:", error);

    await service.from("coa_jobs").update({
      status: "failed",
      error_message: error.message,
    }).eq("id", jobId);

    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
