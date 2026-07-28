import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchRecentTransactions, groupByVendor } from "@/lib/qbo-rules";
import { analyzeBankRules } from "@/lib/claude-rules";
import { NextResponse, after } from "next/server";

/**
 * POST /api/rules/discover
 *
 * Body: { client_link_id: string, months?: number, regenerate?: boolean }
 *
 * Creates a rule_discovery_jobs row, kicks off background analysis,
 * returns immediately with the job ID.
 *
 * INCREMENTAL (default): only vendors that don't already have a rule are
 * analyzed — the monthly top-up.
 *
 * REGENERATE (`regenerate: true`, admin/lead): deletes the client's existing
 * rules first and re-derives ALL of them from transactions against the
 * current master COA. This is the step-2 rebuild after a chart is conformed:
 * rules written against the old chart name accounts that no longer exist and
 * export as blank categories, and incremental discovery can never fix them
 * because it skips any vendor that already has a rule.
 *
 * Regenerate clears ALL of the client's rules, including ones already pushed
 * to QBO. That's deliberate: keeping a pushed rule would also keep its stale
 * target (the existing-pattern filter skips that vendor forever), which is
 * the exact thing we're fixing. Bank rules hold no history, and the import
 * rollout already has the bookkeeper delete QBO's rules before importing the
 * fresh .xls — so nothing is lost. Never do this to accounts; only rules.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { client_link_id, months = 6, regenerate = false } = await request.json();
  if (!client_link_id) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  // Regenerate DELETES rules — senior-only, and never silent.
  let deletedRules = 0;
  if (regenerate) {
    const svc = createServiceSupabase();
    const { data: actor } = await svc.from("users").select("role").eq("id", user.id).single();
    if (!["admin", "lead"].includes((actor as any)?.role || "")) {
      return NextResponse.json(
        { error: "Only admin/lead can regenerate a client's rules." },
        { status: 403 }
      );
    }
    const { data: removed, error: delErr } = await (svc as any)
      .from("bank_rules")
      .delete()
      .eq("client_link_id", client_link_id)
      .select("id, pushed_to_qbo");
    if (delErr) {
      return NextResponse.json({ error: `Couldn't clear existing rules: ${delErr.message}` }, { status: 500 });
    }
    const removedRows = ((removed as any[]) || []);
    deletedRules = removedRows.length;
    const wasPushed = removedRows.filter((r) => r.pushed_to_qbo).length;
    await svc.from("audit_log").insert({
      event_type: "bank_rules_regenerated",
      user_id: user.id,
      request_payload: {
        client_link_id, deleted_rules: deletedRules,
        deleted_previously_pushed: wasPushed, months,
      } as any,
    });
  }

  // Create the job row
  const service = createServiceSupabase();
  const { data: job, error } = await service
    .from("rule_discovery_jobs")
    .insert({
      client_link_id,
      bookkeeper_id: user.id,
      status: "executing",
      months_analyzed: months,
    } as any)
    .select()
    .single();

  if (error || !job) {
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }

  // Background: pull transactions + analyze
  after(async () => {
    try {
      await runDiscovery(job.id, client_link_id, months);
    } catch (err: any) {
      console.error(`Discovery failed for job ${job.id}:`, err);
      await service
        .from("rule_discovery_jobs")
        .update({
          status: "failed",
          error_message: err.message,
        } as any)
        .eq("id", job.id);
    }
  });

  return NextResponse.json({
    job_id: job.id,
    started: true,
    regenerate: !!regenerate,
    deleted_rules: deletedRules,
  });
}

async function runDiscovery(jobId: string, clientLinkId: string, months: number) {
  const service = createServiceSupabase();

  // Load client + master COA
  const { data: client } = await service
    .from("client_links")
    .select("*")
    .eq("id", clientLinkId)
    .single();

  if (!client) throw new Error("Client not found");

  const accessToken = await getValidToken(clientLinkId, service as any);

  // 1. Pull transactions
  const transactions = await fetchRecentTransactions(client.qbo_realm_id, accessToken, months);

  await service
    .from("rule_discovery_jobs")
    .update({ transactions_pulled: transactions.length } as any)
    .eq("id", jobId);

  // 2. Group by vendor (min 2 transactions to be worth a rule)
  const allVendorGroups = groupByVendor(transactions, { minTransactions: 2 });

  // 2a. Filter out vendors that ALREADY have a bank_rule for this client.
  // Without this filter, re-running discovery on the same client (which Mike
  // does monthly on a 3–12 month lookback) would re-analyze the same vendor
  // patterns through Claude — wasting tokens — and then the .insert() below
  // would silently fail on the unique constraint (migration 12), leaving
  // the review UI empty even though discovery "succeeded".
  //
  // We exclude ALL statuses, not just 'active': pending = bookkeeper hasn't
  // decided yet, rejected = bookkeeper deliberately said no (don't keep
  // re-proposing it), approved/active = already a rule. The only thing that
  // resets discovery for a vendor is the bookkeeper hard-deleting the row.
  const { data: existingRules } = await service
    .from("bank_rules")
    .select("vendor_pattern")
    .eq("client_link_id", clientLinkId)
    .not("vendor_pattern", "is", null);

  const existingPatterns = new Set(
    ((existingRules || []) as Array<{ vendor_pattern: string | null }>)
      .map((r) => (r.vendor_pattern || "").toUpperCase().trim())
      .filter(Boolean)
  );

  const vendorGroups = allVendorGroups.filter(
    (v) => !existingPatterns.has((v.vendor_pattern || "").toUpperCase().trim())
  );

  const skippedCount = allVendorGroups.length - vendorGroups.length;
  console.log(
    `[rules-discover ${jobId}] ${allVendorGroups.length} vendors found, ` +
    `${skippedCount} already have rules, ${vendorGroups.length} new to analyze`
  );

  await service
    .from("rule_discovery_jobs")
    .update({ vendors_identified: vendorGroups.length } as any)
    .eq("id", jobId);

  // Short-circuit if nothing new — saves an AI call and gives the UI a
  // clean "no new vendors to rule on" signal instead of an empty review.
  if (vendorGroups.length === 0) {
    await service
      .from("rule_discovery_jobs")
      .update({
        status: "in_review",
        rules_suggested: 0,
        ai_completed_at: new Date().toISOString(),
        error_message: skippedCount > 0
          ? `All ${skippedCount} discovered vendor pattern${skippedCount === 1 ? "" : "s"} already have bank rules — nothing new to propose.`
          : "No vendor patterns met the minimum (2 transactions) for rule suggestion.",
      } as any)
      .eq("id", jobId);
    return;
  }

  // 3. Load master COA
  const { data: masterRows } = await service
    .from("master_coa")
    .select("*")
    .eq("jurisdiction", client.jurisdiction);

  const masterCOA = (masterRows || []).map((m: any) => ({
    account_name: m.account_name,
    parent_account_name: m.parent_account_name,
    is_parent: m.is_parent,
    qbo_account_type: m.qbo_account_type,
    qbo_account_subtype: m.qbo_account_subtype,
    section: m.section,
    notes: m.notes || "",
    is_required: m.is_required,
    tax_treatment: m.tax_treatment,
  }));

  // 4. Run AI analysis
  const analysis = await analyzeBankRules({
    clientName: client.client_name,
    jurisdiction: client.jurisdiction,
    vendorGroups,
    masterCOA,
  });

  // 5. Persist suggestions as pending bank_rules
  // Pull bookkeeper_id once (instead of N times inside the map)
  const { data: jobRow } = await service
    .from("rule_discovery_jobs")
    .select("bookkeeper_id")
    .eq("id", jobId)
    .single();
  const createdBy = (jobRow as any)?.bookkeeper_id || null;

  const rules = analysis.suggestions.map((s) => {
    const vendor = vendorGroups.find((v) => v.vendor_pattern === s.vendor_pattern);
    return {
      client_link_id: clientLinkId,
      discovery_job_id: jobId,
      vendor_pattern: s.vendor_pattern,
      match_type: s.suggested_match_type.toLowerCase(),
      target_account_name: s.target_account_name,
      status: "pending",
      ai_confidence: s.confidence,
      ai_reasoning: s.reasoning,
      requires_approval: s.requires_approval,
      sample_descriptions: vendor?.sample_descriptions || [],
      transaction_count: vendor?.transaction_count || 0,
      total_amount: vendor?.total_amount || 0,
      created_by: createdBy,
    };
  });

  if (rules.length > 0) {
    await service.from("bank_rules").insert(rules as any);
  }

  // 6. Mark job complete
  await service
    .from("rule_discovery_jobs")
    .update({
      status: "in_review",
      rules_suggested: rules.length,
      ai_completed_at: new Date().toISOString(),
    } as any)
    .eq("id", jobId);
}
