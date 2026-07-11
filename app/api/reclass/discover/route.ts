import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  fetchTransactionsForAccount,
  fetchAllTransactionLines,
  getCompanyClosingDate,
  isInClosedPeriod,
  findDoubleClose,
  isDoubleCloseLocked,
  groupLinesByVendor,
  getValidToken,
  sourceFromRequest,
  type ReclassLine,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts, createAccount } from "@/lib/qbo";
import {
  classifyVendorGroups,
  categorizeAllTransactions,
  type ReclassClassification,
  type AvailableAccount,
  type FullCategorizationLine,
  type FullCategorizationDecision,
} from "@/lib/claude-reclass";
import { lookupVendor, normalizeVendorForLookup } from "@/lib/vendor-knowledge";
import { normalizeAccountName } from "@/lib/account-name";
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

  // SAME-CLIENT CONCURRENCY GUARD. Two reclass jobs running on the same
  // client would race on transaction reads/writes — Job A reclassifies a
  // line, Job B (working from a pre-A snapshot) tries to reclassify the
  // same line and gets a "no matching line" failure. Block same-client
  // parallel; different clients in parallel are still fully supported.
  const ACTIVE_RECLASS_STATUSES = ["executing", "in_review", "web_search_paused", "ai_paused"] as any;
  const { data: rivalReclassJobs } = await service
    .from("reclass_jobs")
    .select("id, status, workflow")
    .eq("client_link_id", body.client_link_id)
    .in("status", ACTIVE_RECLASS_STATUSES)
    .limit(1);
  if (rivalReclassJobs && rivalReclassJobs.length > 0) {
    const rival = rivalReclassJobs[0];
    return NextResponse.json(
      {
        error:
          `Another reclass job is already active for this client ` +
          `(job ${rival.id}, workflow=${rival.workflow}, status=${rival.status}). ` +
          `Finish or cancel it before starting a new one — same-client parallel reclass ` +
          `causes transaction-snapshot races.`,
        existing_job_id: rival.id,
      },
      { status: 409 }
    );
  }

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

  // Get fresh QBO token. QBOReauthRequiredError (from getValidToken) now
  // carries a user-friendly message + reconnect URL, so we just let it
  // propagate — the job row's error_message will be the friendly text.
  const accessToken = await getValidToken(
    clientLink.id,
    service as any,
    "ironbooks/api/reclass/discover"
  );

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
    skipAlreadyCorrect: 0,
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
    // All lines → target account, decision=auto_approve (or skip if already there)
    for (const line of inScopeLines) {
      const row = buildReclassRow(jobId, line, {
        target_account_id: job.target_account_id,
        target_account_name: job.target_account_name,
        decision: "auto_approve",
        confidence: 1.0,
        reasoning: `Consolidation: ${job.source_account_name} → ${job.target_account_name}`,
      });
      reclassRows.push(row);
      if (row.decision === "skip") stats.skipAlreadyCorrect++;
      else stats.autoApprove++;
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

        const row = buildReclassRow(jobId, line, {
          target_account_id: classification.target_account_id,
          target_account_name: classification.target_account_name,
          decision: classification.decision,
          confidence: classification.confidence,
          reasoning: classification.reasoning,
        });
        reclassRows.push(row);

        if (row.decision === "skip") stats.skipAlreadyCorrect++;
        else if (row.decision === "auto_approve") stats.autoApprove++;
        else if (row.decision === "needs_review") stats.needsReview++;
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
  // An auto_approve without a target account would silently fail at execution time.
  // Demote it to needs_review so the bookkeeper can assign a target manually.
  const hasTarget = !!(classification.target_account_id);
  let decision =
    !hasTarget && classification.decision === "auto_approve"
      ? "needs_review"
      : classification.decision;

  // NO-OP DETECTION: if the AI/KB/cache target matches the account this
  // transaction is already sitting in, there's nothing to do. Skip it with
  // a clear reason so re-runs after a successful migration show zero work
  // and we don't fire pointless QBO API calls.
  const isNoOp =
    hasTarget &&
    !!line.current_account_id &&
    line.current_account_id === classification.target_account_id;
  let status = "pending";
  let skipReason: string | undefined;
  if (isNoOp) {
    decision = "skip";
    status = "skipped";
    skipReason = "already_correct";
  }

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
    bank_account_name: line.bank_account_name || null,
    original_memo: line.private_note,
    decision,
    ai_confidence: classification.confidence,
    ai_reasoning: classification.reasoning,
    status,
    skip_reason: skipReason,
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
    bank_account_name: line.bank_account_name || null,
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

// ════════════════════════════════════════════════════════════════════════════
// UNCATEGORIZED EXPENSES ACCOUNT
// Ensures a catch-all "Uncategorized Expenses" account exists in the client's
// QBO, creating it if needed. Transactions that can't be categorized land here
// so the bookkeeper can review and recategorize them in QBO rather than having
// them stuck in a failed/pending state in Ironbooks.
// ════════════════════════════════════════════════════════════════════════════

const UNCATEGORIZED_ACCOUNT_NAME = "Uncategorized Expenses";

async function getOrCreateUncategorizedAccount(
  realmId: string,
  accessToken: string,
  availableAccounts: AvailableAccount[]
): Promise<AvailableAccount | null> {
  const existing = availableAccounts.find(
    (a) => (a.account_name || "").toLowerCase() === UNCATEGORIZED_ACCOUNT_NAME.toLowerCase()
  );
  if (existing) return existing;

  try {
    const created = await createAccount(realmId, accessToken, {
      name: UNCATEGORIZED_ACCOUNT_NAME,
      accountType: "Expense",
      accountSubType: "OtherMiscellaneousExpense",
      description: "Transactions that could not be automatically categorized. Review and recategorize as needed.",
    });
    return {
      qbo_account_id: created.Id,
      account_name: created.Name,
      account_type: "Expense",
      account_subtype: "OtherMiscellaneousExpense",
    };
  } catch (err: any) {
    console.warn("[reclass] Could not create Uncategorized Expenses account:", err.message);
    return null;
  }
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
  // Helper: write a step marker to error_message so the UI can show what's
  // happening during the long pre-AI phases (QBO fetches, etc).
  const setPhase = async (label: string) => {
    console.log(`[reclass ${jobId}] ${label}`);
    await service
      .from("reclass_jobs")
      .update({ error_message: `[phase] ${label}` } as any)
      .eq("id", jobId);
  };

  await setPhase("pulling_transactions");

  // Refetch the job to ensure we have the threshold + dates
  const { data: job } = await service
    .from("reclass_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");

  const threshold = (job as any).auto_approve_threshold || 500;

  // 1. Pull every line in the date range. This QBO call can take 2-5 min for
  //    multi-year date ranges on busy clients. Set up a 2-min heartbeat so
  //    the watchdog (which kills jobs silent for >15 min) sees fresh
  //    updated_at while the fetch is in flight.
  const fetchStartedAt = Date.now();
  const fetchHeartbeat = setInterval(() => {
    const sec = Math.floor((Date.now() - fetchStartedAt) / 1000);
    setPhase(`pulling_transactions (${sec}s elapsed)`).catch(() => {});
  }, 120_000);
  let lines: ReclassLine[], transactionsPulled: number, transactionsSkippedUnsupported: number;
  try {
    const result = await fetchAllTransactionLines(
      clientLink.qbo_realm_id,
      accessToken,
      job.date_range_start,
      job.date_range_end
    );
    lines = result.lines;
    transactionsPulled = result.transactionsPulled;
    transactionsSkippedUnsupported = result.transactionsSkippedUnsupported;
  } finally {
    clearInterval(fetchHeartbeat);
  }

  await setPhase("fetching_accounts");

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

  // 3. Fetch all live accounts. We pull every line regardless of source
  //    account (we want to categorize BS-stuck transactions), but only
  //    offer P&L accounts as TARGET options to the AI — BS accounts have
  //    structural meaning and shouldn't be auto-suggested as a category.
  const allAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  // Eligible target types for full-categorization: P&L plus Equity. Equity
  // belongs here because Owner Draw / Owner Contributions are legitimate
  // categorization destinations for painter clients (often commingled
  // accounts where personal expenses get paid from business funds).
  const isReclassTargetType = (t: string | undefined): boolean => {
    if (!t) return false;
    const norm = t.toLowerCase().replace(/\s+/g, "");
    return (
      norm === "income" ||
      norm === "otherincome" ||
      norm === "expense" ||
      norm === "otherexpense" ||
      norm === "costofgoodssold" ||
      norm === "equity"
    );
  };
  const availableAccounts: AvailableAccount[] = allAccounts
    .filter((a) => a.Active !== false && isReclassTargetType(a.AccountType))
    .map((a) => ({
      qbo_account_id: a.Id,
      account_name: a.Name,
      account_type: a.AccountType || "",
      account_subtype: a.AccountSubType || "",
    }));
  console.log(
    `[reclass ${jobId}] QBO accounts: ${allAccounts.length} total, ${availableAccounts.length} eligible. Types present: ${[...new Set(allAccounts.map((a) => a.AccountType))].join(", ")}`
  );

  // Get or create the "Uncategorized Expenses" catch-all account in QBO
  const uncategorizedAccount = await getOrCreateUncategorizedAccount(
    clientLink.qbo_realm_id,
    accessToken,
    availableAccounts
  );
  // Make sure it's in the name→account map so lookups work
  if (uncategorizedAccount && !availableAccounts.find((a) => a.qbo_account_id === uncategorizedAccount.qbo_account_id)) {
    availableAccounts.push(uncategorizedAccount);
  }

  const stats = {
    inScope: 0,
    autoApprove: 0,
    needsReview: 0,
    flagged: 0,
    askClient: 0,
    skipReconciled: 0,
    skipClosedQbo: 0,
    skipClosedDouble: 0,
    skipAlreadyCorrect: 0,
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

  await setPhase("pre_matching");

  // 4.5. PRE-PASS: knowledge base + bank rules cache.
  //   Items that match here skip Claude entirely → faster, cheaper, more accurate.
  //   Items that don't match fall through to Claude in step 5.
  const industry = ((clientLink as any).industry as string) || "painters";
  // Keyed by normalized name (dash/whitespace-insensitive) so client charts
  // with hyphen variants of master's en-dash names still resolve.
  const accountByName = new Map(
    availableAccounts
      .filter((a) => !!a.account_name)
      .map((a) => [normalizeAccountName(a.account_name), a])
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

  // Bank-to-bank transfer patterns. Until we have proper bank-account-number
  // mapping, these can't be auto-categorized — route to ask_client so the
  // bookkeeper can confirm with the client which account it moved to/from.
  // Catches: "ONLINE TRANSFER TO MITCHELL J", "TRANSFER FROM CHECKING",
  // "INTERNAL TRANSFER", "FUNDS TRANSFER", "ZELLE TO/FROM", etc.
  function isBankTransfer(line: ReclassLine): boolean {
    const blob = `${line.vendor_name || ""} ${line.description || ""}`.toUpperCase();
    return (
      /\b(ONLINE\s+TRANSFER|FUNDS?\s+TRANSFER|INTERNAL\s+TRANSFER|WIRE\s+TRANSFER)\b/.test(blob) ||
      /\bTRANSFER\s+(TO|FROM)\b/.test(blob) ||
      /\bACH\s+TRANSFER\b/.test(blob) ||
      /\b(XFER|TFR)\s+(TO|FROM)\b/.test(blob)
    );
  }

  // Owner self-payment detection. A payment whose counterparty text contains
  // the client's own contact name is almost always the owner paying themself —
  // equity (draw/contribution), not P&L. These must land on the balance sheet
  // (JP audit, Dominion Painters: "Kevin Casson" e-transfers were the owner).
  // Requires BOTH first and last name in the text so business names sharing
  // the owner's surname don't trip it. Never auto-categorized: suggest the
  // client's draw-style equity account and route to ask_client to confirm.
  const ownerFirst = String((clientLink as any).contact_first_name || "").trim().toLowerCase();
  const ownerLast = String((clientLink as any).contact_last_name || "").trim().toLowerCase();
  const ownerDrawAccount =
    availableAccounts.find((a) => /owner'?s?\s+draw/i.test(a.account_name)) ||
    availableAccounts.find(
      (a) =>
        (a.account_type || "").toLowerCase() === "equity" &&
        /draw|distribut|shareholder|withdraw/i.test(a.account_name)
    ) ||
    null;
  function isOwnerPayment(line: ReclassLine): boolean {
    if (ownerFirst.length < 3 || ownerLast.length < 3) return false;
    const blob = `${line.vendor_name || ""} ${line.description || ""}`.toLowerCase();
    return blob.includes(ownerFirst) && blob.includes(ownerLast);
  }

  for (const line of inScopeLines) {
    const refId = `${line.transaction_id}::${line.line_id}`;
    const absAmount = Math.abs(line.transaction_amount);

    // -1) Owner self-payment — suggest equity, confirm with client.
    if (isOwnerPayment(line)) {
      preMatched.set(refId, {
        ref_id: refId,
        target_account_id: ownerDrawAccount?.qbo_account_id || null,
        target_account_name: ownerDrawAccount?.account_name || null,
        confidence: 0.6,
        reasoning: `Counterparty matches the client's owner (${(clientLink as any).contact_first_name} ${(clientLink as any).contact_last_name}) — likely an owner draw or contribution (equity, not P&L). Confirm with the client before posting.`,
        decision: "ask_client",
      });
      stats.askClient++;
      continue;
    }

    // 0) Bank-transfer pre-check — never auto-categorize, always ask_client.
    if (isBankTransfer(line)) {
      preMatched.set(refId, {
        ref_id: refId,
        target_account_id: null,
        target_account_name: null,
        confidence: 0,
        reasoning: "Detected as a bank-to-bank transfer. Confirm with client which account this moved to/from before categorizing.",
        decision: "ask_client",
      });
      stats.askClient++;
      continue;
    }

    // 1) Knowledge base lookup (static, ~200 patterns, instant)
    const kbMatch = lookupVendor(line.vendor_name, line.description, line.transaction_amount, industry);
    if (kbMatch) {
      const account = kbMatch.account ? accountByName.get(normalizeAccountName(kbMatch.account)) : undefined;
      if (account) {
        preMatched.set(refId, {
          ref_id: refId,
          target_account_id: account.qbo_account_id,
          target_account_name: account.account_name,
          confidence: kbMatch.confidence,
          reasoning: kbMatch.reasoning,
          // Pre-matched from the knowledge base → pre-approve; bookkeeper reviews
          // the one list and can change any row before posting.
          decision: "auto_approve",
        });
      } else {
        // The KB's suggested account doesn't exist in this client's live QBO
        // chart. Never substitute a fallback account while displaying the
        // intended name — that silently posts to Uncategorized under a label
        // that says "Fuel" (Dominion Painters, 2026-07-10: 5 fuel transactions
        // executed to "Uncategorized Expenses" while our records said
        // "Fuel – Admin & Sales Vehicles"; 1,554 rows fleet-wide). Land
        // honestly on the real Uncategorized account, under its real name,
        // and force bookkeeper review so nothing posts unseen.
        preMatched.set(refId, {
          ref_id: refId,
          target_account_id: uncategorizedAccount?.qbo_account_id || null,
          target_account_name: uncategorizedAccount?.account_name || null,
          confidence: kbMatch.confidence,
          reasoning: `KB suggested account "${kbMatch.account}" which does not exist in this client's QBO — create it or pick another account before approving.`,
          decision: uncategorizedAccount ? "needs_review" : "flagged",
        });
      }
      kbHits++;
      continue;
    }

    // 2) Per-client bank rules cache (instant DB lookup, already done)
    const normalized = normalizeForBankRule(line.vendor_name);
    const cachedAccountName = normalized ? bankRulesByVendor.get(normalized) : undefined;
    if (cachedAccountName) {
      const account = accountByName.get(normalizeAccountName(cachedAccountName));
      if (account) {
        preMatched.set(refId, {
          ref_id: refId,
          target_account_id: account.qbo_account_id,
          target_account_name: account.account_name,
          confidence: 1.0,
          reasoning: "Matched existing bank rule from prior categorization",
          decision: "auto_approve",
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

  // ── LARGE JOBS: durable, resumable chunked AI categorization ─────────────
  // A multi-month range can have more lines than one serverless invocation can
  // categorize before the function budget runs out — and the single-pass path
  // below builds every row in memory and bulk-inserts only at the very end, so
  // a mid-run timeout loses everything (James Painting LLC, Jun 2026: 0 rows).
  //
  // For big jobs we persist the already-decided rows now, enqueue every line
  // still needing Claude into reclass_ai_queue, and pause at status='ai_paused'.
  // The bookkeeper clicks Continue (→ /api/reclass/[id]/categorize-chunk), which
  // runs runAiChunks() in a FRESH invocation with its own 800s budget — writing
  // real reclassifications rows + draining the queue in time-bounded chunks,
  // pausing again between runs for approval. No invocation can time out
  // mid-categorization, and progress is never lost. Small jobs keep the
  // simpler single-pass path below unchanged.
  if (linesForClaude.length > AI_CHUNK_THRESHOLD) {
    // 1. Persist the decided-now rows: skip rows (already in reclassRows) plus
    //    the pre-matched (KB / bank-rule / transfer) decisions.
    const refIdToLinePrep = new Map<string, ReclassLine>();
    for (const l of inScopeLines) refIdToLinePrep.set(`${l.transaction_id}::${l.line_id}`, l);
    for (const [refId, decision] of preMatched) {
      const line = refIdToLinePrep.get(refId);
      if (!line) continue;
      reclassRows.push(buildRowFromAiDecision(jobId, line, decision, uncategorizedAccount));
    }
    await setPhase(`saving (${reclassRows.length} decided rows)`);
    const PREP_BATCH = 500;
    for (let i = 0; i < reclassRows.length; i += PREP_BATCH) {
      const { error: insErr } = await service
        .from("reclassifications")
        .insert(reclassRows.slice(i, i + PREP_BATCH));
      if (insErr) throw new Error(`Decided-row insert failed: ${insErr.message}`);
    }

    // 2. Enqueue everything still needing Claude (full ReclassLine payloads, so
    //    a chunk run rebuilds the AI input + the row without re-fetching QBO).
    const queueRows = linesForClaude.map((l) => ({
      reclass_job_id: jobId,
      ref_id: `${l.transaction_id}::${l.line_id}`,
      payload: l as any,
    }));
    const Q_BATCH = 500;
    for (let i = 0; i < queueRows.length; i += Q_BATCH) {
      const { error: qErr } = await service
        .from("reclass_ai_queue" as any)
        .insert(queueRows.slice(i, i + Q_BATCH));
      if (qErr) throw new Error(`Queue enqueue failed: ${qErr.message}`);
    }

    // 3. Persist the stats we already know. The AI-decision counts + the
    //    web-search vendor list are computed from the rows at finalize.
    const uniqueVendorsPrep = new Set(lines.map((l) => l.vendor_name).filter(Boolean)).size;
    const { error: prepErr } = await service
      .from("reclass_jobs")
      .update({
        transactions_pulled: transactionsPulled,
        transactions_in_scope: stats.inScope,
        transactions_skipped_reconciled: stats.skipReconciled,
        transactions_skipped_closed: stats.skipClosedQbo + stats.skipClosedDouble,
        transactions_skipped_unsupported: stats.skipUnsupported,
        unique_vendors_count: uniqueVendorsPrep,
        status: "ai_paused",
        error_message: `[ai_progress] 0/${linesForClaude.length}`,
      } as any)
      .eq("id", jobId);
    if (prepErr) throw new Error(`Chunk prep update failed: ${prepErr.message}`);

    console.log(
      `[reclass ${jobId}] chunked AI armed — ${reclassRows.length} decided now, ${linesForClaude.length} queued for Claude (chunk size ${AI_CHUNK_SIZE}). Awaiting Continue.`
    );
    return;
  }

  await setPhase(`running_ai (${linesForClaude.length} lines)`);

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

  // Run AI categorization. Simple sequential flow: each batch writes its
  // progress to error_message, the UI polls /status every 2s to display it.
  // No skip-AI signal, no abort wiring — the job runs to completion. If the
  // bookkeeper truly needs out, they cancel the whole job.
  const aiResult = await categorizeAllTransactions({
    clientName: clientLink.client_name,
    jurisdiction: clientLink.jurisdiction,
    stateProvince: clientLink.state_province || "",
    lines: aiLines,
    availableAccounts,
    autoApproveThreshold: threshold,
    onProgress: async (done, total) => {
      await service
        .from("reclass_jobs")
        .update({ error_message: `[ai_progress] ${done}/${total}` } as any)
        .eq("id", jobId);
    },
  });

  // 6. Build reclass rows — merge AI decisions with pre-matched ones
  const decisionByRef = new Map<string, FullCategorizationDecision>();
  for (const [ref, d] of preMatched) decisionByRef.set(ref, d);
  for (const d of aiResult.decisions) decisionByRef.set(d.ref_id, d);

  // 6.5. Identify vendors that COULD benefit from web search — used to drive
  //   the "Web search N vendors or continue to review?" choice screen after
  //   AI completes. The actual searches don't run here; the bookkeeper makes
  //   the call from the UI after seeing the count.
  //
  //   Eligible vendors:
  //     - decision is flagged or needs_review
  //     - confidence < 0.7
  //     - real vendor name (not empty, not "Unknown vendor")
  //   Skipped for ask_client (peer payments) and skip rows.
  const refIdToLine = new Map<string, ReclassLine>();
  for (const l of inScopeLines) {
    refIdToLine.set(`${l.transaction_id}::${l.line_id}`, l);
  }
  const uniqueWsVendors = new Set<string>();
  for (const [refId, decision] of decisionByRef) {
    if (decision.decision === "ask_client") continue;
    if ((decision.confidence ?? 0) >= 0.7) continue;
    const line = refIdToLine.get(refId);
    if (!line) continue;
    const v = (line.vendor_name || "").trim();
    if (!v) continue;
    if (v.toLowerCase() === "unknown vendor") continue;
    if (v.length < 2) continue;
    uniqueWsVendors.add(v);
  }

  for (const line of inScopeLines) {
    const refId = `${line.transaction_id}::${line.line_id}`;
    const decision = decisionByRef.get(refId);

    // Single source of truth for AI-decision → row resolution (also used by the
    // chunked path). Handles the no-decision case, honest Uncategorized
    // soft-landing (real id + real name, needs_review), and never auto-executes
    // a fallback.
    const row = buildRowFromAiDecision(jobId, line, decision, uncategorizedAccount);
    reclassRows.push(row);

    if (row.decision === "skip") stats.skipAlreadyCorrect++;
    else if (row.decision === "auto_approve") stats.autoApprove++;
    else if (row.decision === "needs_review") stats.needsReview++;
    else if (row.decision === "ask_client") stats.askClient++;
    else stats.flagged++;
  }

  await setPhase(`saving (${reclassRows.length} rows)`);

  // 7. Bulk insert all rows (initial AI decisions — web search will upgrade some later).
  // Heartbeat: update phase after each batch so the watchdog sees fresh
  // updated_at during what can be a multi-minute insert on big clients.
  const BATCH_SIZE = 500;
  const totalInsertBatches = Math.ceil(reclassRows.length / BATCH_SIZE);
  for (let i = 0; i < reclassRows.length; i += BATCH_SIZE) {
    const batch = reclassRows.slice(i, i + BATCH_SIZE);
    const { error: insertErr } = await service.from("reclassifications").insert(batch);
    if (insertErr) throw new Error(`Insert batch failed: ${insertErr.message}`);
    const insertBatchIdx = Math.floor(i / BATCH_SIZE) + 1;
    // Bump updated_at with progress info every batch so the watchdog (which
    // kills jobs silent for >15 min) never false-fires on a slow-but-working
    // bulk insert.
    await setPhase(`saving (${insertBatchIdx * BATCH_SIZE > reclassRows.length ? reclassRows.length : insertBatchIdx * BATCH_SIZE}/${reclassRows.length} rows)`);
  }

  if (stats.skipAlreadyCorrect > 0) {
    console.log(`[reclass] ${stats.skipAlreadyCorrect} already-correct transactions skipped.`);
  }
  if (stats.askClient > 0) {
    console.log(`[reclass] ${stats.askClient} bank-transfer lines routed to ask_client.`);
  }

  const uniqueVendors = new Set(lines.map((l) => l.vendor_name).filter(Boolean)).size;

  // 8. AI done. If there are vendors that could benefit from web search, pause
  //    at web_search_paused with the count — the bookkeeper picks "Web search"
  //    or "Skip to manual review" from the UI. Otherwise go straight to in_review.
  const wsCount = uniqueWsVendors.size;
  const baseUpdate: any = {
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
  };
  const finalState: any = wsCount > 0
    ? { ...baseUpdate, status: "web_search_paused", error_message: `[ws_pending] ${wsCount}` }
    : { ...baseUpdate, status: "in_review", error_message: null };

  const { error: finalErr } = await service
    .from("reclass_jobs")
    .update(finalState)
    .eq("id", jobId);
  if (finalErr) throw new Error(`Final status update failed: ${finalErr.message}`);
  console.log(`[reclass ${jobId}] DONE — moved to ${finalState.status}${wsCount > 0 ? ` (${wsCount} vendors pending web search)` : ""}`);
}

// ============== CHUNKED AI CATEGORIZATION (large jobs) ==============
//
// Lines-to-Claude above which discovery switches from the single-pass path to
// the durable, resumable chunked path (persist decided rows + enqueue the rest
// + pause at ai_paused; categorize-chunk drains the queue in time-bounded runs).
const AI_CHUNK_THRESHOLD = 120;
// Lines dequeued + sent to Claude per pass within a categorize-chunk run.
const AI_CHUNK_SIZE = 60;
// Wall-clock budget for one categorize-chunk run. maxDuration is 800s; we stop
// starting new chunks at 10 min and pause cleanly so the invocation always
// returns before the platform kills it.
const AI_CHUNK_BUDGET_MS = 10 * 60 * 1000;

/**
 * Map one AI decision (or its absence) to a reclassifications row, applying the
 * SAME resolution rules as the single-pass path (lines ~920-968): ask_client /
 * flagged keep their own (possibly null) target; needs_review with no target
 * gets a soft landing to Uncategorized; a missing decision falls back to
 * needs_review (or flagged if there's no Uncategorized account).
 */
function buildRowFromAiDecision(
  jobId: string,
  line: ReclassLine,
  decision: FullCategorizationDecision | undefined,
  uncategorizedAccount: AvailableAccount | null
) {
  if (!decision) {
    return buildReclassRow(jobId, line, {
      target_account_id: uncategorizedAccount?.qbo_account_id || null,
      target_account_name: uncategorizedAccount?.account_name || null,
      decision: uncategorizedAccount ? "needs_review" : "flagged",
      confidence: 0,
      reasoning: uncategorizedAccount
        ? "AI did not return a decision — needs bookkeeper review before executing."
        : "AI did not return a decision for this line.",
    });
  }
  const isAskClient = decision.decision === "ask_client";
  const isFlagged = decision.decision === "flagged";
  const baseReasoning = decision.flagged_reason || decision.reasoning;

  // ask_client / flagged keep their own (possibly null) target — never soft-land.
  if (isAskClient || isFlagged) {
    return buildReclassRow(jobId, line, {
      target_account_id: decision.target_account_id || null,
      target_account_name: decision.target_account_name || null,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoning: baseReasoning,
    });
  }

  // Resolved AI target present → use its id+name verbatim (matched pair).
  if (decision.target_account_id) {
    return buildReclassRow(jobId, line, {
      target_account_id: decision.target_account_id,
      target_account_name: decision.target_account_name || null,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoning: baseReasoning,
    });
  }

  // No resolved target. Soft-land on the client's real Uncategorized account —
  // but under its REAL name (never the AI's unresolved intended name, which
  // would display an account the row won't post to) — and force needs_review so
  // no fallback ever auto-executes. Preserve the intended name in the reasoning.
  if (uncategorizedAccount) {
    const intended = decision.target_account_name;
    return buildReclassRow(jobId, line, {
      target_account_id: uncategorizedAccount.qbo_account_id,
      target_account_name: uncategorizedAccount.account_name,
      decision: "needs_review",
      confidence: decision.confidence,
      reasoning: intended
        ? `AI suggested "${intended}" which could not be resolved to an account in this client's QBO — create it or pick another account before approving. (${baseReasoning})`
        : baseReasoning,
    });
  }

  // No Uncategorized account to land on either → flag with no target.
  return buildReclassRow(jobId, line, {
    target_account_id: null,
    target_account_name: null,
    decision: "flagged",
    confidence: decision.confidence,
    reasoning: baseReasoning,
  });
}

/**
 * Finalize a chunked full_categorization once its queue is empty. Decision
 * counts + the web-search-eligible vendor list are recomputed from the rows we
 * actually wrote (durable across pauses/retries). The pulled / in-scope /
 * skipped stats were already persisted when discovery enqueued the work.
 */
async function finalizeFullCategorization(
  service: ReturnType<typeof createServiceSupabase>,
  jobId: string
): Promise<void> {
  const { data: rows } = await service
    .from("reclassifications")
    .select("decision, ai_confidence, vendor_name")
    .eq("reclass_job_id", jobId);

  let autoApprove = 0;
  let needsReview = 0;
  let flagged = 0;
  const wsVendors = new Set<string>();
  for (const r of (rows || []) as any[]) {
    if (r.decision === "auto_approve") autoApprove++;
    else if (r.decision === "needs_review") needsReview++;
    else if (r.decision === "flagged") flagged++;

    // Web-search eligibility mirrors the single-pass rule: skip ask_client +
    // skip rows (reconciled / closed / no-op), skip confidence >= 0.7, require
    // a real vendor name.
    if (r.decision === "ask_client" || r.decision === "skip") continue;
    if ((r.ai_confidence ?? 0) >= 0.7) continue;
    const v = (r.vendor_name || "").trim();
    if (!v || v.length < 2 || v.toLowerCase() === "unknown vendor") continue;
    wsVendors.add(v);
  }

  const wsCount = wsVendors.size;
  const baseUpdate: any = {
    transactions_auto_approve: autoApprove,
    transactions_needs_review: needsReview,
    transactions_flagged: flagged,
    ai_completed_at: new Date().toISOString(),
  };
  const finalState: any =
    wsCount > 0
      ? { ...baseUpdate, status: "web_search_paused", error_message: `[ws_pending] ${wsCount}` }
      : { ...baseUpdate, status: "in_review", error_message: null };

  const { error } = await service.from("reclass_jobs").update(finalState).eq("id", jobId);
  if (error) throw new Error(`Final status update failed: ${error.message}`);
  console.log(
    `[reclass ${jobId}] DONE (chunked) — moved to ${finalState.status}${wsCount > 0 ? ` (${wsCount} vendors pending web search)` : ""}`
  );
}

/**
 * Process a job's reclass_ai_queue in time-bounded chunks. Self-contained
 * (re-loads job + client + token + accounts) so it runs identically whether
 * kicked off by discovery or by the categorize-chunk Continue endpoint. Inserts
 * rows BEFORE deleting their queue entries (never lose categorization work),
 * pauses at status='ai_paused' when the time budget is hit with work left, and
 * finalizes when the queue drains.
 */
export async function runAiChunks(jobId: string): Promise<void> {
  const service = createServiceSupabase();
  const startedAt = Date.now();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;
  if (!clientLink) throw new Error("Client link not found");
  const threshold: number = (job as any).auto_approve_threshold || 500;

  // Total AI line count is carried in the [ai_progress] denominator the
  // discovery step wrote ("[ai_progress] 0/N"). The retry path preserves a
  // valid "[ai_progress] done/N" prefix too, so this parse holds across
  // retries. Fall back to live queue depth on the first pass if absent.
  const totalMatch = ((job as any).error_message || "").match(/\[ai_progress\]\s*\d+\/(\d+)/);
  let aiTotal: number | null = totalMatch ? parseInt(totalMatch[1], 10) : null;

  const accessToken = await getValidToken(clientLink.id, service as any, "ironbooks/api/reclass/categorize-chunk");
  const allAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  // Same eligible-target filter as discovery (P&L + equity) so the chunk runs
  // see the identical account set discovery offered.
  const isReclassTargetType = (t: string | undefined): boolean => {
    if (!t) return false;
    const norm = t.toLowerCase().replace(/\s+/g, "");
    return (
      norm === "income" ||
      norm === "otherincome" ||
      norm === "expense" ||
      norm === "otherexpense" ||
      norm === "costofgoodssold" ||
      norm === "equity"
    );
  };
  const availableAccounts: AvailableAccount[] = allAccounts
    .filter((a) => a.Active !== false && isReclassTargetType(a.AccountType))
    .map((a) => ({
      qbo_account_id: a.Id,
      account_name: a.Name,
      account_type: a.AccountType || "",
      account_subtype: a.AccountSubType || "",
    }));
  const uncategorizedAccount = await getOrCreateUncategorizedAccount(
    clientLink.qbo_realm_id,
    accessToken,
    availableAccounts
  );
  if (
    uncategorizedAccount &&
    !availableAccounts.find((a) => a.qbo_account_id === uncategorizedAccount.qbo_account_id)
  ) {
    availableAccounts.push(uncategorizedAccount);
  }

  // Flip to executing while this run works (the Continue gate sets ai_paused
  // between runs; finalize sets web_search_paused / in_review).
  await service.from("reclass_jobs").update({ status: "executing" } as any).eq("id", jobId);

  const countRemaining = async (): Promise<number> => {
    const { count } = await service
      .from("reclass_ai_queue" as any)
      .select("id", { count: "exact", head: true })
      .eq("reclass_job_id", jobId);
    return count || 0;
  };

  while (true) {
    const remainingBefore = await countRemaining();
    if (aiTotal == null) aiTotal = remainingBefore;
    if (remainingBefore === 0) {
      await finalizeFullCategorization(service, jobId);
      return;
    }

    // Out of budget with work left → pause for the bookkeeper's Continue click.
    // Rows from completed chunks are already persisted + dequeued; nothing lost.
    if (Date.now() - startedAt > AI_CHUNK_BUDGET_MS) {
      const done = Math.max(0, (aiTotal || 0) - remainingBefore);
      await service
        .from("reclass_jobs")
        .update({ status: "ai_paused", error_message: `[ai_progress] ${done}/${aiTotal}` } as any)
        .eq("id", jobId);
      console.log(`[reclass ${jobId}] AI paused — ${done}/${aiTotal} categorized, ${remainingBefore} remaining`);
      return;
    }

    // Dequeue the next chunk (FIFO).
    const { data: queued, error: qErr } = await service
      .from("reclass_ai_queue" as any)
      .select("id, payload")
      .eq("reclass_job_id", jobId)
      .order("id", { ascending: true })
      .limit(AI_CHUNK_SIZE);
    if (qErr) throw new Error(`Queue read failed: ${qErr.message}`);
    if (!queued || queued.length === 0) {
      await finalizeFullCategorization(service, jobId);
      return;
    }

    const chunkLines: ReclassLine[] = queued.map((q: any) => q.payload as ReclassLine);
    const aiLines: FullCategorizationLine[] = chunkLines.map((l) => ({
      ref_id: `${l.transaction_id}::${l.line_id}`,
      vendor_name: l.vendor_name,
      amount: l.transaction_amount,
      date: l.transaction_date,
      description: l.description,
      private_note: l.private_note,
      current_account_name: l.current_account_name,
    }));

    const doneBase = Math.max(0, (aiTotal || 0) - remainingBefore);
    const aiResult = await categorizeAllTransactions({
      clientName: clientLink.client_name,
      jurisdiction: clientLink.jurisdiction,
      stateProvince: clientLink.state_province || "",
      lines: aiLines,
      availableAccounts,
      autoApproveThreshold: threshold,
      onProgress: async (doneBatches, totalBatches) => {
        // Heartbeat (keeps updated_at fresh for the watchdog) + smooth global
        // progress: already-done + this chunk's batch fraction.
        const within = totalBatches > 0 ? Math.round((doneBatches / totalBatches) * chunkLines.length) : 0;
        const globalDone = Math.min(aiTotal || 0, doneBase + within);
        await service
          .from("reclass_jobs")
          .update({ error_message: `[ai_progress] ${globalDone}/${aiTotal}` } as any)
          .eq("id", jobId);
      },
    });

    const decisionByRef = new Map<string, FullCategorizationDecision>();
    for (const d of aiResult.decisions) decisionByRef.set(d.ref_id, d);

    const rows = chunkLines.map((line) =>
      buildRowFromAiDecision(
        jobId,
        line,
        decisionByRef.get(`${line.transaction_id}::${line.line_id}`),
        uncategorizedAccount
      )
    );

    // Insert rows BEFORE deleting the queue entries. If the invocation dies in
    // the gap, the worst case is a watchdog-failed job whose partial rows are
    // kept (bookkeeper starts fresh) — never lost work. ai_paused is only set
    // at the top-of-loop budget check, after a clean insert+delete, so the
    // normal Continue flow can't re-process a chunk and duplicate rows.
    const { error: insErr } = await service.from("reclassifications").insert(rows as any);
    if (insErr) throw new Error(`Chunk insert failed: ${insErr.message}`);

    const ids = queued.map((q: any) => q.id);
    const { error: delErr } = await service.from("reclass_ai_queue" as any).delete().in("id", ids);
    if (delErr) throw new Error(`Queue delete failed: ${delErr.message}`);

    const remainingAfter = Math.max(0, remainingBefore - rows.length);
    const done = Math.max(0, (aiTotal || 0) - remainingAfter);
    await service
      .from("reclass_jobs")
      .update({ error_message: `[ai_progress] ${done}/${aiTotal}` } as any)
      .eq("id", jobId);
  }
}

/**
 * Build the auto-generated reason for full_categorization jobs.
 * Format: "Ironbooks Categorization, May 2026, MGH"
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

  return `Ironbooks Categorization, ${month} ${year}${initials ? `, ${initials}` : ""}`;
}

export const maxDuration = 800;
