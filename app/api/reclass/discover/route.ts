import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  fetchTransactionsForAccount,
  fetchAllTransactionLines,
  getCompanyClosingDate,
  isInClosedPeriod,
  groupLinesByVendor,
  getValidToken,
  type ReclassLine,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts } from "@/lib/qbo";
import {
  classifyVendorGroups,
  categorizeAllTransactions,
  webSearchVendor,
  type ReclassClassification,
  type AvailableAccount,
  type FullCategorizationLine,
  type FullCategorizationDecision,
} from "@/lib/claude-reclass";
import { lookupVendor, normalizeVendorForLookup } from "@/lib/vendor-knowledge";
import { getClientEndCloses, type DoubleEndCloseSummary } from "@/lib/double";

/**
 * POST /api/reclass/discover
 *
 * Body:
 * {
 *   client_link_id: string,
 *   workflow: "consolidation" | "scrub",
 *   source_account_id: string,
 *   source_account_name: string,
 *   target_account_id?: string,        // required for consolidation
 *   target_account_name?: string,
 *   date_range_start: string,           // YYYY-MM-DD
 *   date_range_end: string,             // YYYY-MM-DD
 *   jurisdiction: "US" | "CA",
 *   state_province: string,
 *   reason: string
 * }
 *
 * Validates inputs, creates reclass_jobs row, kicks off background discovery.
 * Returns job_id immediately.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // Base required fields (apply to all workflows). Reason is checked separately
  // since it's auto-generated for full_categorization workflows.
  const baseRequired = ["client_link_id", "workflow", "date_range_start", "date_range_end", "jurisdiction"];
  for (const f of baseRequired) {
    if (!body[f]) {
      return NextResponse.json({ error: `Missing required field: ${f}` }, { status: 400 });
    }
  }

  if (!["consolidation", "scrub", "full_categorization"].includes(body.workflow)) {
    return NextResponse.json({ error: "Invalid workflow" }, { status: 400 });
  }

  // Workflow-specific validation
  if (body.workflow === "consolidation" || body.workflow === "scrub") {
    if (!body.source_account_id || !body.source_account_name) {
      return NextResponse.json(
        { error: "source_account_id and source_account_name are required for this workflow" },
        { status: 400 }
      );
    }
    if (body.workflow === "consolidation" && !body.target_account_id) {
      return NextResponse.json(
        { error: "target_account_id is required for consolidation workflow" },
        { status: 400 }
      );
    }
    if (body.source_account_id === body.target_account_id) {
      return NextResponse.json(
        { error: "Source and target cannot be the same account" },
        { status: 400 }
      );
    }
  }
  if (body.workflow === "full_categorization") {
    if (!body.auto_approve_threshold || body.auto_approve_threshold <= 0) {
      return NextResponse.json(
        { error: "auto_approve_threshold (>0) is required for full_categorization" },
        { status: 400 }
      );
    }
  }

  // Date range validation
  const startDate = new Date(body.date_range_start);
  const endDate = new Date(body.date_range_end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return NextResponse.json({ error: "Invalid date format (use YYYY-MM-DD)" }, { status: 400 });
  }
  if (endDate < startDate) {
    return NextResponse.json({ error: "End date must be >= start date" }, { status: 400 });
  }
  // 1-year cap only for consolidation/scrub. full_categorization can run multi-year.
  if (body.workflow !== "full_categorization") {
    const daysDiff = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
    if (daysDiff > 366) {
      return NextResponse.json(
        { error: "Date range exceeds 1 year. Run multiple jobs for multi-year cleanup." },
        { status: 400 }
      );
    }
  }

  // Reason: required for consolidation/scrub (bespoke decisions). Auto-generated for
  // full_categorization since it's the standard cleanup step — no judgment-call to record.
  let finalReason: string;
  if (body.workflow === "full_categorization") {
    finalReason = await buildAutoReason(supabase, user.id);
  } else {
    if (!body.reason || body.reason.trim().length < 5) {
      return NextResponse.json(
        { error: "Reason must be at least 5 characters" },
        { status: 400 }
      );
    }
    finalReason = body.reason.trim();
  }

  const service = createServiceSupabase();

  const { data: job, error } = await service
    .from("reclass_jobs")
    .insert({
      client_link_id: body.client_link_id,
      bookkeeper_id: user.id,
      workflow: body.workflow,
      status: "executing", // executing the discovery phase
      source_account_id: body.source_account_id || null,
      source_account_name: body.source_account_name || null,
      target_account_id: body.target_account_id || null,
      target_account_name: body.target_account_name || null,
      date_range_start: body.date_range_start,
      date_range_end: body.date_range_end,
      jurisdiction: body.jurisdiction,
      state_province: body.state_province || null,
      reason: finalReason,
      auto_approve_threshold: body.auto_approve_threshold || null,
    } as any)
    .select()
    .single();

  if (error || !job) {
    return NextResponse.json({ error: error?.message || "Job creation failed" }, { status: 500 });
  }

  // Schedule background work
  after(async () => {
    try {
      await runDiscovery(job.id);
    } catch (err: any) {
      console.error(`Discovery failed for reclass_job ${job.id}:`, err);
      const svc = createServiceSupabase();
      await svc
        .from("reclass_jobs")
        .update({
          status: "failed",
          error_message: err.message,
          ai_completed_at: new Date().toISOString(),
        } as any)
        .eq("id", job.id);
    }
  });

  return NextResponse.json({ job_id: job.id, started: true });
}

// ============== BACKGROUND DISCOVERY ==============

async function runDiscovery(jobId: string) {
  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;

  // Get fresh QBO token
  const accessToken = await getValidToken(clientLink.id, service as any);

  // ─────────── FULL CATEGORIZATION pipeline ───────────
  if (job.workflow === "full_categorization") {
    await runFullCategorization(jobId, service, clientLink, accessToken);
    return;
  }

  // 1. Pull all transactions hitting source account in date range
  const { lines, transactionsPulled, transactionsSkippedUnsupported } =
    await fetchTransactionsForAccount(
      clientLink.qbo_realm_id,
      accessToken,
      job.source_account_id!,
      job.date_range_start,
      job.date_range_end
    );

  // 2. Get QBO books closing date
  const bookCloseDate = await getCompanyClosingDate(clientLink.qbo_realm_id, accessToken);

  // 3. Pull Double end-closes for additional period protection
  let doubleCloses: DoubleEndCloseSummary[] = [];
  if (
    clientLink.double_client_id &&
    !clientLink.double_client_id.startsWith("pending_")
  ) {
    try {
      const dcId = parseInt(clientLink.double_client_id, 10);
      if (!isNaN(dcId)) {
        doubleCloses = await getClientEndCloses(dcId);
      }
    } catch (err: any) {
      console.warn(`Failed to fetch Double end-closes:`, err.message);
    }
  }

  // 4. Get all QBO accounts for target lookup
  const allAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const accountById = new Map(allAccounts.map((a) => [a.Id, a]));

  // 5. Classify each line: skip vs reclassify
  const stats = {
    inScope: 0,
    autoApprove: 0,
    needsReview: 0,
    flagged: 0,
    skipReconciled: 0,
    skipClosedQbo: 0,
    skipClosedDouble: 0,
    skipUnsupported: transactionsSkippedUnsupported,
  };

  const reclassRows: any[] = [];

  // For workflow B (consolidation): all in-scope lines map to single target with decision=auto_approve
  // For workflow C (scrub): we run AI on vendor groups

  // First pass: determine skip vs in-scope for each line
  const inScopeLines: ReclassLine[] = [];

  for (const line of lines) {
    // Closed period checks (QBO + Double)
    if (isInClosedPeriod(line.transaction_date, bookCloseDate)) {
      stats.skipClosedQbo++;
      reclassRows.push(buildSkipRow(jobId, line, "closed_period_qbo"));
      continue;
    }
    const doubleClose = findDoubleClose(line.transaction_date, doubleCloses);
    if (doubleClose && isDoubleCloseLocked(doubleClose.status)) {
      stats.skipClosedDouble++;
      reclassRows.push(buildSkipRow(jobId, line, "closed_period_double"));
      continue;
    }

    // Reconciled check (hard-block by default; admin override comes later via separate endpoint)
    if (line.is_reconciled) {
      stats.skipReconciled++;
      reclassRows.push(buildSkipRow(jobId, line, "reconciled"));
      continue;
    }

    inScopeLines.push(line);
  }
  stats.inScope = inScopeLines.length;

  // Now process in-scope lines based on workflow
  if (job.workflow === "consolidation") {
    // All lines → target account, decision=auto_approve
    for (const line of inScopeLines) {
      reclassRows.push(
        buildReclassRow(jobId, line, {
          target_account_id: job.target_account_id,
          target_account_name: job.target_account_name,
          decision: "auto_approve",
          confidence: 1.0,
          reasoning: `Consolidation: ${job.source_account_name} → ${job.target_account_name}`,
        })
      );
      stats.autoApprove++;
    }
  } else {
    // Workflow C: scrub mode with AI
    const vendorGroups = groupLinesByVendor(inScopeLines);

    // Build available accounts list (excluding source)
    const availableAccounts: AvailableAccount[] = allAccounts
      .filter((a) => a.Id !== job.source_account_id && a.Active !== false)
      .map((a) => ({
        qbo_account_id: a.Id,
        account_name: a.Name,
        account_type: a.AccountType || "",
        account_subtype: a.AccountSubType || "",
      }));

    // Run Claude classification
    const aiResult = await classifyVendorGroups({
      clientName: clientLink.client_name,
      jurisdiction: clientLink.jurisdiction,
      stateProvince: clientLink.state_province || "",
      sourceAccountName: job.source_account_name,
      vendorGroups,
      availableAccounts,
    });

    // Build classification lookup
    const classByPattern = new Map<string, ReclassClassification>();
    for (const c of aiResult.classifications) {
      classByPattern.set(c.vendor_pattern, c);
    }

    // Apply classification to each line in each group
    for (const group of vendorGroups) {
      const classification = classByPattern.get(group.vendor_pattern);

      for (const line of group.lines) {
        if (!classification) {
          // Unclassified → flagged
          reclassRows.push(
            buildReclassRow(jobId, line, {
              target_account_id: null,
              target_account_name: null,
              decision: "flagged",
              confidence: 0,
              reasoning: "AI could not confidently classify this vendor",
            })
          );
          stats.flagged++;
          continue;
        }

        reclassRows.push(
          buildReclassRow(jobId, line, {
            target_account_id: classification.target_account_id,
            target_account_name: classification.target_account_name,
            decision: classification.decision,
            confidence: classification.confidence,
            reasoning: classification.reasoning,
          })
        );

        if (classification.decision === "auto_approve") stats.autoApprove++;
        else if (classification.decision === "needs_review") stats.needsReview++;
        else stats.flagged++;
      }
    }

    // Save warnings
    if (aiResult.warnings.length > 0) {
      await service
        .from("reclass_jobs")
        .update({ warnings: aiResult.warnings as any } as any)
        .eq("id", jobId);
    }
  }

  // Bulk insert reclassification rows (batch to avoid 1MB limit per insert)
  const BATCH_SIZE = 500;
  for (let i = 0; i < reclassRows.length; i += BATCH_SIZE) {
    const batch = reclassRows.slice(i, i + BATCH_SIZE);
    const { error: insertErr } = await service.from("reclassifications").insert(batch);
    if (insertErr) {
      throw new Error(`Failed to insert reclassifications batch: ${insertErr.message}`);
    }
  }

  // Count unique vendors
  const uniqueVendors = new Set(
    lines.map((l) => l.vendor_name).filter(Boolean)
  ).size;

  // Update job with discovery stats
  await service
    .from("reclass_jobs")
    .update({
      status: "in_review",
      transactions_pulled: transactionsPulled,
      transactions_in_scope: stats.inScope,
      transactions_auto_approve: stats.autoApprove,
      transactions_needs_review: stats.needsReview,
      transactions_flagged: stats.flagged,
      transactions_skipped_reconciled: stats.skipReconciled,
      transactions_skipped_closed: stats.skipClosedQbo + stats.skipClosedDouble,
      transactions_skipped_unsupported: stats.skipUnsupported,
      unique_vendors_count: uniqueVendors,
      ai_completed_at: new Date().toISOString(),
    } as any)
    .eq("id", jobId);
}

// ============== HELPERS ==============

function buildReclassRow(
  jobId: string,
  line: ReclassLine,
  classification: {
    target_account_id: string | null;
    target_account_name: string | null;
    decision: string;
    confidence: number;
    reasoning: string;
  }
) {
  return {
    job_id: jobId, // legacy column - we satisfy NOT NULL by reusing
    reclass_job_id: jobId,
    qbo_transaction_id: line.transaction_id,
    qbo_transaction_type: line.transaction_type,
    line_id: line.line_id,
    sync_token: line.sync_token,
    from_account_id: line.current_account_id,
    from_account_name: line.current_account_name,
    to_account_id: classification.target_account_id || "",
    to_account_name: classification.target_account_name || "",
    transaction_amount: line.transaction_amount,
    transaction_date: line.transaction_date,
    description: line.description,
    vendor_name: line.vendor_name,
    vendor_pattern_normalized: normalizeVendor(line.vendor_name),
    is_reconciled: line.is_reconciled,
    is_bank_fed: line.is_bank_fed,
    is_manual_entry: line.is_manual_entry,
    original_memo: line.private_note,
    decision: classification.decision,
    ai_confidence: classification.confidence,
    ai_reasoning: classification.reasoning,
    status: "pending",
  };
}

function buildSkipRow(jobId: string, line: ReclassLine, skipReason: string) {
  return {
    job_id: jobId,
    reclass_job_id: jobId,
    qbo_transaction_id: line.transaction_id,
    qbo_transaction_type: line.transaction_type,
    line_id: line.line_id,
    sync_token: line.sync_token,
    from_account_id: line.current_account_id,
    from_account_name: line.current_account_name,
    to_account_id: "",
    to_account_name: "",
    transaction_amount: line.transaction_amount,
    transaction_date: line.transaction_date,
    description: line.description,
    vendor_name: line.vendor_name,
    vendor_pattern_normalized: normalizeVendor(line.vendor_name),
    is_reconciled: line.is_reconciled,
    is_bank_fed: line.is_bank_fed,
    is_manual_entry: line.is_manual_entry,
    original_memo: line.private_note,
    decision: "skip",
    skip_reason: skipReason,
    status: "skipped",
  };
}

function normalizeVendor(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[#\-_*\/\\.,]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(CO|INC|LLC|LTD|CORP|COMPANY|THE|STORE|#\d+|\d+)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findDoubleClose(
  txnDate: string,
  closes: DoubleEndCloseSummary[]
): DoubleEndCloseSummary | null {
  const d = new Date(txnDate);
  const yearMonth = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return closes.find((c) => c.yearMonth === yearMonth) || null;
}

function isDoubleCloseLocked(status: string): boolean {
  // Lock on any "completed" or "delivered" status. Conservative: also treat null/unknown
  // as NOT locked (don't false-positive).
  return ["complete", "completed", "closed", "delivered"].includes(status.toLowerCase());
}

// ════════════════════════════════════════════════════════════════════════════
// FULL CATEGORIZATION DISCOVERY
// Pulls every line in date range, runs Claude line-level classification,
// applies the auto-approve threshold, and writes reclassifications rows.
// ════════════════════════════════════════════════════════════════════════════

async function runFullCategorization(
  jobId: string,
  service: ReturnType<typeof createServiceSupabase>,
  clientLink: any,
  accessToken: string
) {
  // Refetch the job to ensure we have the threshold + dates
  const { data: job } = await service
    .from("reclass_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");

  const threshold = (job as any).auto_approve_threshold || 500;

  // 1. Pull every line in the date range
  const { lines, transactionsPulled, transactionsSkippedUnsupported } =
    await fetchAllTransactionLines(
      clientLink.qbo_realm_id,
      accessToken,
      job.date_range_start,
      job.date_range_end
    );

  // 2. Closed-period guards (QBO + Double)
  const bookCloseDate = await getCompanyClosingDate(clientLink.qbo_realm_id, accessToken);
  let doubleCloses: DoubleEndCloseSummary[] = [];
  if (clientLink.double_client_id && !clientLink.double_client_id.startsWith("pending_")) {
    try {
      const dcId = parseInt(clientLink.double_client_id, 10);
      if (!isNaN(dcId)) {
        doubleCloses = await getClientEndCloses(dcId);
      }
    } catch (err: any) {
      console.warn("Failed to fetch Double end-closes:", err.message);
    }
  }

  // 3. Fetch all live accounts for target options
  const allAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const availableAccounts: AvailableAccount[] = allAccounts
    .filter((a) => a.Active !== false)
    .map((a) => ({
      qbo_account_id: a.Id,
      account_name: a.Name,
      account_type: a.AccountType || "",
      account_subtype: a.AccountSubType || "",
    }));

  const stats = {
    inScope: 0,
    autoApprove: 0,
    needsReview: 0,
    flagged: 0,
    skipReconciled: 0,
    skipClosedQbo: 0,
    skipClosedDouble: 0,
    skipUnsupported: transactionsSkippedUnsupported,
  };
  const reclassRows: any[] = [];
  const inScopeLines: ReclassLine[] = [];

  // 4. Filter to in-scope vs skipped
  for (const line of lines) {
    if (isInClosedPeriod(line.transaction_date, bookCloseDate)) {
      stats.skipClosedQbo++;
      reclassRows.push(buildSkipRow(jobId, line, "closed_period_qbo"));
      continue;
    }
    const doubleClose = findDoubleClose(line.transaction_date, doubleCloses);
    if (doubleClose && isDoubleCloseLocked(doubleClose.status)) {
      stats.skipClosedDouble++;
      reclassRows.push(buildSkipRow(jobId, line, "closed_period_double"));
      continue;
    }
    if (line.is_reconciled) {
      stats.skipReconciled++;
      reclassRows.push(buildSkipRow(jobId, line, "reconciled"));
      continue;
    }
    inScopeLines.push(line);
  }
  stats.inScope = inScopeLines.length;

  // 4.5. PRE-PASS: knowledge base + bank rules cache.
  //   Items that match here skip Claude entirely → faster, cheaper, more accurate.
  //   Items that don't match fall through to Claude in step 5.
  const industry = ((clientLink as any).industry as string) || "painters";
  const accountByName = new Map(
    availableAccounts.map((a) => [a.account_name.toLowerCase(), a])
  );

  // Fetch per-client bank rules (vendor → account mappings learned from past runs)
  const { data: bankRules } = await service
    .from("bank_rules")
    .select("vendor_pattern, target_account_name")
    .eq("client_link_id", clientLink.id);
  const bankRulesByVendor = new Map<string, string>(
    (bankRules || [])
      .filter((r: any) => r.vendor_pattern && r.target_account_name)
      .map((r: any) => [String(r.vendor_pattern).toUpperCase(), String(r.target_account_name)])
  );

  function normalizeForBankRule(name: string): string {
    return normalizeVendorForLookup(name)
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const preMatched = new Map<string, FullCategorizationDecision>();
  const linesForClaude: ReclassLine[] = [];
  let kbHits = 0;
  let cacheHits = 0;

  for (const line of inScopeLines) {
    const refId = `${line.transaction_id}::${line.line_id}`;
    const absAmount = Math.abs(line.transaction_amount);

    // 1) Knowledge base lookup (static, ~200 patterns, instant)
    const kbMatch = lookupVendor(line.vendor_name, line.description, line.transaction_amount, industry);
    if (kbMatch) {
      const account = accountByName.get(kbMatch.account.toLowerCase());
      if (account) {
        preMatched.set(refId, {
          ref_id: refId,
          target_account_id: account.qbo_account_id,
          target_account_name: account.account_name,
          confidence: kbMatch.confidence,
          reasoning: kbMatch.reasoning,
          decision:
            kbMatch.confidence >= 0.80 && absAmount < threshold
              ? "auto_approve"
              : "needs_review",
        });
        kbHits++;
        continue;
      }
    }

    // 2) Per-client bank rules cache (instant DB lookup, already done)
    const normalized = normalizeForBankRule(line.vendor_name);
    const cachedAccountName = normalized ? bankRulesByVendor.get(normalized) : undefined;
    if (cachedAccountName) {
      const account = accountByName.get(cachedAccountName.toLowerCase());
      if (account) {
        preMatched.set(refId, {
          ref_id: refId,
          target_account_id: account.qbo_account_id,
          target_account_name: account.account_name,
          confidence: 1.0,
          reasoning: "Matched existing bank rule from prior categorization",
          decision: absAmount < threshold ? "auto_approve" : "needs_review",
        });
        cacheHits++;
        continue;
      }
    }

    // No pre-match → needs AI
    linesForClaude.push(line);
  }

  console.log(
    `[reclass] Pre-pass: ${kbHits} knowledge-base hits, ${cacheHits} bank-rule cache hits, ${linesForClaude.length} sent to Claude.`
  );

  // 5. Pass remaining lines to Claude
  const aiLines: FullCategorizationLine[] = linesForClaude.map((l) => ({
    ref_id: `${l.transaction_id}::${l.line_id}`,
    vendor_name: l.vendor_name,
    amount: l.transaction_amount,
    date: l.transaction_date,
    description: l.description,
    private_note: l.private_note,
    current_account_name: l.current_account_name,
  }));

  const aiResult = await categorizeAllTransactions({
    clientName: clientLink.client_name,
    jurisdiction: clientLink.jurisdiction,
    stateProvince: clientLink.state_province || "",
    lines: aiLines,
    availableAccounts,
    autoApproveThreshold: threshold,
  });

  // 6. Build reclass rows — merge AI decisions with pre-matched ones
  const decisionByRef = new Map<string, FullCategorizationDecision>();
  for (const [ref, d] of preMatched) decisionByRef.set(ref, d);
  for (const d of aiResult.decisions) decisionByRef.set(d.ref_id, d);

  // 6.5. WEB SEARCH PASS for low-confidence Claude results.
  //   Only fires on UNIQUE vendor names (we dedupe so we don't waste API calls on
  //   the same vendor repeated 20 times). Results are written back to bank_rules
  //   so re-runs and other transactions for the same vendor skip web search.
  const clientCity = (clientLink as any).state_province || null;
  const lowConfDecisions = aiResult.decisions.filter(
    (d) => d.decision === "flagged" || (d.decision === "needs_review" && d.confidence < 0.7)
  );

  // Dedupe by normalized vendor name — search each unique vendor only once
  const lineByRef = new Map<string, ReclassLine>();
  for (const l of inScopeLines) {
    lineByRef.set(`${l.transaction_id}::${l.line_id}`, l);
  }
  const uniqueVendorsToSearch = new Map<string, { vendorName: string; refIds: string[] }>();
  for (const d of lowConfDecisions) {
    const line = lineByRef.get(d.ref_id);
    if (!line || !line.vendor_name) continue;
    const norm = normalizeForBankRule(line.vendor_name);
    if (!norm) continue;
    if (!uniqueVendorsToSearch.has(norm)) {
      uniqueVendorsToSearch.set(norm, { vendorName: line.vendor_name, refIds: [] });
    }
    uniqueVendorsToSearch.get(norm)!.refIds.push(d.ref_id);
  }

  if (uniqueVendorsToSearch.size > 0) {
    console.log(`[reclass] Web-searching ${uniqueVendorsToSearch.size} unique unknown vendors...`);

    const newBankRules: any[] = [];
    for (const [normalized, info] of uniqueVendorsToSearch) {
      try {
        const result = await webSearchVendor({
          vendorName: info.vendorName,
          clientCity: clientCity || undefined,
          availableAccounts,
        });
        if (result && result.target_account_id && result.confidence >= 0.65) {
          // Update every transaction with the same vendor
          for (const refId of info.refIds) {
            const existing = decisionByRef.get(refId);
            decisionByRef.set(refId, {
              ref_id: refId,
              target_account_id: result.target_account_id,
              target_account_name: result.target_account_name,
              confidence: result.confidence,
              reasoning: result.reasoning,
              decision:
                result.confidence >= 0.80 ? "auto_approve" : "needs_review",
              flagged_reason: existing?.flagged_reason,
            });
          }
          // Cache this match as a bank rule so future runs skip the search
          newBankRules.push({
            client_link_id: clientLink.id,
            vendor_pattern: normalized,
            target_account_name: result.target_account_name,
            ai_confidence: result.confidence,
            ai_reasoning: result.reasoning,
            match_type: "CONTAINS",
            status: "approved",
            requires_approval: false,
            created_by: job.bookkeeper_id,
            pushed_to_qbo: false,
          });
        }
      } catch (err: any) {
        console.warn(`[reclass] Web search failed for "${info.vendorName}":`, err.message);
      }
    }

    // Bulk-insert new bank rules in one shot (skip dupes via vendor_pattern uniqueness)
    if (newBankRules.length > 0) {
      try {
        await service
          .from("bank_rules")
          .upsert(newBankRules, { onConflict: "client_link_id,vendor_pattern", ignoreDuplicates: false } as any);
        console.log(`[reclass] Cached ${newBankRules.length} new bank rules from web search`);
      } catch (err: any) {
        console.warn(`[reclass] Failed to cache bank rules:`, err.message);
      }
    }
  }

  for (const line of inScopeLines) {
    const refId = `${line.transaction_id}::${line.line_id}`;
    const decision = decisionByRef.get(refId);

    if (!decision) {
      reclassRows.push(
        buildReclassRow(jobId, line, {
          target_account_id: null,
          target_account_name: null,
          decision: "flagged",
          confidence: 0,
          reasoning: "AI did not return a decision for this line.",
        })
      );
      stats.flagged++;
      continue;
    }

    reclassRows.push(
      buildReclassRow(jobId, line, {
        target_account_id: decision.target_account_id,
        target_account_name: decision.target_account_name,
        decision: decision.decision,
        confidence: decision.confidence,
        reasoning: decision.flagged_reason || decision.reasoning,
      })
    );

    if (decision.decision === "auto_approve") stats.autoApprove++;
    else if (decision.decision === "needs_review") stats.needsReview++;
    else stats.flagged++;
  }

  // 7. Bulk insert
  const BATCH_SIZE = 500;
  for (let i = 0; i < reclassRows.length; i += BATCH_SIZE) {
    const batch = reclassRows.slice(i, i + BATCH_SIZE);
    const { error: insertErr } = await service.from("reclassifications").insert(batch);
    if (insertErr) throw new Error(`Insert batch failed: ${insertErr.message}`);
  }

  const uniqueVendors = new Set(lines.map((l) => l.vendor_name).filter(Boolean)).size;

  await service
    .from("reclass_jobs")
    .update({
      status: "in_review",
      transactions_pulled: transactionsPulled,
      transactions_in_scope: stats.inScope,
      transactions_auto_approve: stats.autoApprove,
      transactions_needs_review: stats.needsReview,
      transactions_flagged: stats.flagged,
      transactions_skipped_reconciled: stats.skipReconciled,
      transactions_skipped_closed: stats.skipClosedQbo + stats.skipClosedDouble,
      transactions_skipped_unsupported: stats.skipUnsupported,
      unique_vendors_count: uniqueVendors,
      ai_completed_at: new Date().toISOString(),
      warnings: aiResult.warnings.length > 0 ? (aiResult.warnings as any) : null,
    } as any)
    .eq("id", jobId);
}

/**
 * Build the auto-generated reason for full_categorization jobs.
 * Format: "IronBooks Categorization, May 2026, MGH"
 *   - month spelled out + year
 *   - bookkeeper initials from users.full_name
 */
async function buildAutoReason(
  supabase: any,
  userId: string
): Promise<string> {
  const { data: profile } = await supabase
    .from("users")
    .select("full_name")
    .eq("id", userId)
    .single();

  const fullName: string = profile?.full_name || "";
  const initials = fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((part: string) => part.charAt(0).toUpperCase())
    .join("");

  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long" });
  const year = now.getFullYear();

  return `IronBooks Categorization, ${month} ${year}${initials ? `, ${initials}` : ""}`;
}

export const maxDuration = 300;
