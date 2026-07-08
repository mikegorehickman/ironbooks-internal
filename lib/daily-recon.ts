/**
 * Daily reconciliation worker — LIVE (writes to client QBO ledgers).
 * =================================================================
 *
 * Wired live: vercel.json runs /api/cron/daily-recon?dryRun=false daily, and
 * /admin/daily-recon can trigger it for enrolled clients (daily_recon_enabled).
 * dryRun=true is still the default for ad-hoc/admin previews — nothing writes
 * to QBO in dry-run mode — but the scheduled run executes for real.
 *
 * Pulls the delta of new QBO transactions since the client's last_synced_at,
 * runs the same 4-tier pipeline as reclass discovery (KB → bank rules → AI →
 * web search), then either:
 *   - Auto-executes high-confidence (>=0.95) matches via reclassifyTransactionLines
 *   - Queues medium/low-confidence + anomaly-flagged items for bookkeeper review
 *
 * Idempotency: every QBO line we touch is recorded in processed_qbo_lines, so
 * re-running a window is a no-op for already-processed lines. (Note: the JE/
 * reclass QBO write itself is not yet token-idempotent — a crash AFTER the QBO
 * write but BEFORE the processed_qbo_lines insert could re-touch a line on the
 * next run. Low-frequency, tracked separately.)
 *
 * Safety bar — guards before any auto-execute:
 *   - Closed-period gate: never auto-execute a line dated on/before the QBO
 *     book-close date (getBookCloseDate); such lines queue flagged 'closed_period'
 *   - Hard-block list (payroll, tax authorities, owner draws) — always queue
 *   - Per-run cap: if auto_executed > MAX_AUTO_PER_RUN, pause the client and
 *     queue everything for the remainder of the run
 *   - target_account_id must be live in QBO's current COA (accountById) before
 *     auto-execute
 *   - any anomaly flag on a line forces it to the review queue
 */

import { createServiceSupabase } from "./supabase";
import { fetchAllTransactionLines, getValidToken, reclassifyTransactionLines, type ReclassLine } from "./qbo-reclass";
import { fetchAllAccounts, getBookCloseDate } from "./qbo";
import {
  categorizeAllTransactions,
  webSearchVendor,
  type AvailableAccount,
  type FullCategorizationLine,
  type FullCategorizationDecision,
} from "./claude-reclass";
import { lookupVendor, normalizeVendorForLookup } from "./vendor-knowledge";

// ─── CONSTANTS ─────────────────────────────────────────────────────────────

const AUTO_EXECUTE_CONFIDENCE = 0.95;
const WEB_SEARCH_AUTO_FLOOR = 0.92; // higher floor than direct AI — less direct evidence
const MAX_AUTO_PER_RUN = 20;        // safety cap; exceeding pauses the client
const DEFAULT_LOOKBACK_DAYS = 7;    // if no last_synced_at, look back this far

// Account names QBO uses for "this transaction hasn't been categorized yet".
// Bank rules ONLY fire when a transaction sits in one of these — if the
// bookkeeper has already moved it elsewhere (manually or via a previous
// recon), we respect their decision and leave it alone. This prevents the
// engine from clobbering human edits between sync and the next run.
//
// Match is lower-case substring so we catch "Uncategorized Expense",
// "Uncategorised Expense" (UK spelling), "Uncategorized Asset", custom
// names like "Unassigned Expenses", etc. without an exhaustive enum.
const UNCATEGORIZED_ACCOUNT_PATTERNS = [
  "uncategorized",
  "uncategorised",   // UK spelling — QBO Global uses this
  "unassigned",
  "ask my accountant",
  "ask my client",   // SNAP convention for "client confirmation needed"
];

function isUncategorizedAccount(accountName: string | null | undefined): boolean {
  if (!accountName) return true; // null/empty = effectively uncategorized
  const lower = accountName.toLowerCase();
  return UNCATEGORIZED_ACCOUNT_PATTERNS.some((p) => lower.includes(p));
}

// Sensitive vendor patterns that NEVER auto-execute regardless of confidence.
// Same list as scrub mode's "needs review" flagging — payroll, tax, owner
// draws are too consequential to ship without a human looking.
const HARD_BLOCK_PATTERNS = [
  /\bpayroll\b/i,
  /\bgusto\b/i,
  /\badp\b/i,
  /\bwagepoint\b/i,
  /\bpayworks\b/i,
  /\bquickbooks\s*payroll\b/i,
  /\birs\b/i,
  /\bcra\b/i,
  /\bstate\s+revenue\b/i,
  /\btax\s+(payment|deposit|levy)\b/i,
  /\bowner\b/i,
  /\bdraw\b/i,
  /\bdistribution\b/i,
  /\bshareholder\s+loan\b/i,
];

// ─── TYPES ─────────────────────────────────────────────────────────────────

export interface DailyReconResult {
  run_id: string | null; // null in dry-run when we don't persist
  client_link_id: string;
  status: "complete" | "failed" | "dry_run";
  fetched_from: string | null;
  fetched_to: string;
  transactions_pulled: number;
  auto_executed: number;
  queued_for_review: number;
  /** Lines a bank rule matched but were either already in the target account
   *  or already categorized by a human in a non-default account. Skipped to
   *  avoid clobbering human edits. */
  already_categorized?: number;
  anomalies_count: number;
  duration_ms: number;
  error?: string;
  preview?: Array<PreviewItem>; // populated in dry-run for inspection
}

interface PreviewItem {
  qbo_line_id: string;
  vendor_name: string | null;
  amount: number;
  date: string;
  suggested_account_name: string | null;
  confidence: number;
  source: "kb" | "bank_rule" | "ai" | "web_search" | "unmatched" | "already_categorized";
  would_auto_execute: boolean;
  anomaly_flags: Array<{ code: string; message: string }>;
}

export interface DailyReconOptions {
  dryRun?: boolean;          // default true — safety
  lookbackDays?: number;     // override for back-fill testing
  maxLines?: number;         // hard cap on lines processed (testing)
}

// ─── ENTRY POINT ───────────────────────────────────────────────────────────

/**
 * Run the daily reconciliation pipeline for a single client.
 *
 * Safe to call manually from an admin endpoint. Defaults to dryRun=true so
 * a casual call won't ship anything to QBO.
 */
export async function runDailyRecon(
  clientLinkId: string,
  opts: DailyReconOptions = {}
): Promise<DailyReconResult> {
  const dryRun = opts.dryRun ?? true;
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const maxLines = opts.maxLines ?? 500;

  const t0 = Date.now();
  const service = createServiceSupabase();

  const result: DailyReconResult = {
    run_id: null,
    client_link_id: clientLinkId,
    status: dryRun ? "dry_run" : "complete",
    fetched_from: null,
    fetched_to: new Date().toISOString(),
    transactions_pulled: 0,
    auto_executed: 0,
    queued_for_review: 0,
    anomalies_count: 0,
    duration_ms: 0,
    preview: dryRun ? [] : undefined,
  };

  try {
    // 1. Load the client + check feature flag + read last_synced_at
    const { data: client } = await service
      .from("client_links")
      .select("*")
      .eq("id", clientLinkId)
      .single();
    if (!client) throw new Error(`Client ${clientLinkId} not found`);
    const c: any = client;

    if (!c.daily_recon_enabled) {
      throw new Error(`Client ${clientLinkId} does not have daily_recon_enabled — skipping.`);
    }
    if (c.daily_recon_paused) {
      throw new Error(`Client ${clientLinkId} is paused: ${c.daily_recon_paused_reason || "(no reason)"}.`);
    }

    // 2. Compute delta window.
    //
    // CRITICAL: the QBO fetch filters on TxnDate, but bank feeds deliver
    // transactions DATED 1-3 days in the past (feed lag) — sometimes longer
    // over weekends/holidays. A pure watermark window therefore misses
    // almost every bank-fed transaction: by the time it lands in QBO its
    // date is already behind last_synced_at. (This is exactly how the
    // engine went quiet after the June 29 catch-up run: 173 of 174 runs
    // found zero transactions while the feeds kept delivering.)
    //
    // Fix: always look back at least LATE_ARRIVAL_FLOOR_DAYS, regardless of
    // the watermark. Overlapping windows are safe and cheap — the
    // processed_qbo_lines uniqueness below makes re-scanned lines no-ops.
    const LATE_ARRIVAL_FLOOR_DAYS = 10;
    const watermark = c.last_synced_at
      ? new Date(c.last_synced_at)
      : new Date(Date.now() - lookbackDays * 86400000);
    const lateFloor = new Date(Date.now() - LATE_ARRIVAL_FLOOR_DAYS * 86400000);
    const fetchedFrom = watermark < lateFloor ? watermark : lateFloor;
    const fetchedTo = new Date();
    result.fetched_from = fetchedFrom.toISOString();
    result.fetched_to = fetchedTo.toISOString();

    // 3. Create the run row up-front so we have an ID to attach to processed_qbo_lines
    if (!dryRun) {
      const { data: run } = await service
        .from("daily_recon_runs" as any)
        .insert({
          client_link_id: clientLinkId,
          fetched_from: result.fetched_from,
          fetched_to: result.fetched_to,
          status: "running",
          dry_run: false,
        } as any)
        .select()
        .single();
      result.run_id = (run as any)?.id || null;
    }

    // 4. Fetch QBO delta. We use a date-range fetch and let the
    //    processed_qbo_lines uniqueness handle dedup across overlapping
    //    windows.
    const accessToken = await getValidToken(clientLinkId, service as any);
    const fromYmd = fetchedFrom.toISOString().slice(0, 10);
    const toYmd = fetchedTo.toISOString().slice(0, 10);

    const { lines: rawLines } = await fetchAllTransactionLines(
      c.qbo_realm_id,
      accessToken,
      fromYmd,
      toYmd
    );

    // 5. Filter out already-processed lines (idempotency)
    const lineIds = rawLines.map((l) => l.line_id);
    let alreadyProcessed = new Set<string>();
    if (lineIds.length > 0) {
      const { data: already } = await service
        .from("processed_qbo_lines" as any)
        .select("qbo_line_id")
        .eq("client_link_id", clientLinkId)
        .in("qbo_line_id", lineIds);
      alreadyProcessed = new Set(
        ((already as any[]) || []).map((r) => r.qbo_line_id)
      );
    }
    const newLines = rawLines
      .filter((l) => !alreadyProcessed.has(l.line_id))
      .slice(0, maxLines);

    result.transactions_pulled = newLines.length;

    // 6. Early exit if nothing new
    if (newLines.length === 0) {
      result.duration_ms = Date.now() - t0;
      if (!dryRun && result.run_id) {
        await markRunComplete(service, result);
        // Bump last_synced_at even when no new lines — we want the next run
        // to start from "now", not from the same empty window.
        await service
          .from("client_links")
          .update({ last_synced_at: result.fetched_to } as any)
          .eq("id", clientLinkId);
      }
      return result;
    }

    // 7. Load live QBO COA for target-account validation
    const allQboAccounts = await fetchAllAccounts(c.qbo_realm_id, accessToken);
    const availableAccounts: AvailableAccount[] = allQboAccounts
      .filter((a) => a.Active !== false)
      .map((a) => ({
        qbo_account_id: a.Id,
        account_name: a.Name,
        account_type: a.AccountType || "",
        account_subtype: a.AccountSubType || "",
      }));
    const accountById = new Map(availableAccounts.map((a) => [a.qbo_account_id, a]));
    const accountByName = new Map(
      availableAccounts.map((a) => [a.account_name.toLowerCase(), a])
    );

    // 7b. Closed-period guard. Read the client's QBO book-close date so we
    //     NEVER auto-reclassify a transaction dated in a closed (filed)
    //     period — those go to the review queue flagged 'closed_period'
    //     instead. Fail-soft: if we can't read it, treat as no close date
    //     (the per-run cap + hard-block list + confidence floor still apply).
    let bookCloseDate: string | null = null;
    try {
      bookCloseDate = await getBookCloseDate(c.qbo_realm_id, accessToken);
    } catch (e: any) {
      console.warn(
        `[daily-recon ${clientLinkId}] could not read book-close date:`,
        e?.message
      );
    }

    // 8. Load bank rules cache
    const { data: bankRules } = await service
      .from("bank_rules")
      .select("vendor_pattern, target_account_name")
      .eq("client_link_id", clientLinkId);
    const bankRulesByVendor = new Map<string, string>(
      (bankRules || [])
        .filter((r: any) => r.vendor_pattern && r.target_account_name)
        .map((r: any) => [String(r.vendor_pattern).toUpperCase(), String(r.target_account_name)])
    );

    // 9. Run the 4-tier pipeline.
    const industry = (c.industry as string) || "painters";
    const decisions: Map<string, PipelineDecision> = new Map(); // line_id → decision
    const aiLines: FullCategorizationLine[] = [];

    for (const line of newLines) {
      const refId = line.line_id;

      // Tier 1: KB lookup
      const kb = lookupVendor(line.vendor_name, line.description, line.transaction_amount, industry);
      if (kb && kb.account) {
        const account = accountByName.get(kb.account.toLowerCase());
        decisions.set(refId, {
          source: "kb",
          target_account_id: account?.qbo_account_id || null,
          target_account_name: account?.account_name || kb.account,
          confidence: kb.confidence,
          reasoning: kb.reasoning,
        });
        continue;
      }

      // Tier 2: bank rules
      const normalized = normalizeVendorForLookup(line.vendor_name).toUpperCase();
      const ruleHit = normalized ? bankRulesByVendor.get(normalized) : undefined;
      if (ruleHit) {
        const account = accountByName.get(ruleHit.toLowerCase());
        if (account) {
          // ─── Idempotency guard ─────────────────────────────────────
          // Two cases where we should NOT apply the rule:
          //   1. Line is ALREADY in the rule's target account (no-op).
          //   2. Line is in some OTHER non-default account — meaning a
          //      human bookkeeper categorized it manually in QBO between
          //      the QBO sync and this recon run. Overwriting their
          //      choice would silently undo human work.
          //
          // We only fire the rule when the line is genuinely uncategorized
          // (sitting in Uncategorized Expense / Income / Ask My Accountant
          // / etc. — see UNCATEGORIZED_ACCOUNT_PATTERNS).
          const currentIsTarget =
            line.current_account_id === account.qbo_account_id ||
            (line.current_account_name || "").toLowerCase() ===
              account.account_name.toLowerCase();

          if (currentIsTarget) {
            // Already where the rule wants it — settled, no-op.
            // Source "already_categorized" tells the loop below to skip
            // both auto-execute AND the human review queue so we don't
            // pester the bookkeeper about lines that need no action.
            decisions.set(refId, {
              source: "already_categorized",
              target_account_id: account.qbo_account_id,
              target_account_name: account.account_name,
              confidence: 1.0,
              reasoning: "Already in rule's target account — no change needed",
            });
            continue;
          }

          if (!isUncategorizedAccount(line.current_account_name)) {
            // Human (or upstream system) already categorized this elsewhere.
            // Respect that. Don't queue it for AI either — that's how you end
            // up "helpfully" re-suggesting changes the bookkeeper rejected.
            decisions.set(refId, {
              source: "already_categorized",
              target_account_id: null,
              target_account_name: null,
              confidence: 0,
              reasoning: `Skipped: already categorized in "${line.current_account_name}" (rule would have moved it to "${account.account_name}")`,
            });
            continue;
          }

          // Genuinely uncategorized — fire the rule.
          decisions.set(refId, {
            source: "bank_rule",
            target_account_id: account.qbo_account_id,
            target_account_name: account.account_name,
            confidence: 1.0,
            reasoning: "Matched saved bank rule",
          });
          continue;
        }
      }

      // Tier 3 (AI) — collect for batch
      aiLines.push({
        ref_id: refId,
        vendor_name: line.vendor_name,
        amount: line.transaction_amount,
        date: line.transaction_date,
        description: line.description,
        private_note: line.private_note,
        current_account_name: line.current_account_name,
      });
    }

    if (aiLines.length > 0) {
      const aiResult = await categorizeAllTransactions({
        clientName: c.client_name,
        jurisdiction: c.jurisdiction,
        stateProvince: c.state_province || "",
        lines: aiLines,
        availableAccounts,
        autoApproveThreshold: c.auto_approve_threshold || 500,
      });
      for (const d of aiResult.decisions) {
        decisions.set(d.ref_id, {
          source: "ai",
          target_account_id: d.target_account_id,
          target_account_name: d.target_account_name,
          confidence: d.confidence,
          reasoning: d.reasoning,
        });
      }
    }

    // Tier 4 (web search) — only for AI-tier lines with confidence <0.7 and real vendor name
    // SCAFFOLD: we deliberately skip web search in the first cut of daily recon
    // because the user emphasized "back-end web search must be bulletproof"
    // before running unsupervised. Once we have shadow-mode data showing the
    // AI tier is reliable enough, we can layer web search back in here.
    //
    // TODO(when wiring): re-enable web search loop here using webSearchVendor()
    // similar to the discover route's web search step. Cap at 50 vendors per
    // run to bound function runtime.
    void webSearchVendor; // keep import alive

    // 10. Anomaly detection (stubbed — see detectAnomalies)
    const allLineIds = newLines.map((l) => l.line_id);
    const anomalies = await detectAnomalies(service, clientLinkId, newLines);

    // 11. For each new line, decide auto-execute vs queue
    let autoExecuteCount = 0;
    let alreadyCategorizedCount = 0; // surfaced in audit_log for visibility
    const queueRows: any[] = [];
    const processedRows: any[] = [];
    const linesToExecute: Array<{ line: ReclassLine; decision: PipelineDecision }> = [];

    for (const line of newLines) {
      const d = decisions.get(line.line_id) || {
        source: "unmatched" as const,
        target_account_id: null,
        target_account_name: null,
        confidence: 0,
        reasoning: "No KB / bank rule match and AI did not return a decision",
      };

      const lineAnomalies = [...(anomalies.get(line.line_id) || [])];
      // Closed-period guard: a transaction dated on/before the QBO book-close
      // date lives in a filed period — flag it so it can never auto-execute
      // and the bookkeeper sees why it's in the queue.
      if (
        bookCloseDate &&
        line.transaction_date &&
        String(line.transaction_date).slice(0, 10) <= bookCloseDate
      ) {
        lineAnomalies.push({
          code: "closed_period",
          message: `Transaction dated ${String(line.transaction_date).slice(0, 10)} is on/before the QBO book-close date (${bookCloseDate}) — queued instead of auto-applied so a filed period is never silently changed.`,
        });
      }
      // Deposit→income guard: a bank Deposit coded to an ordinary Income
      // account double-counts revenue on invoice-driven books — the invoice
      // already recognized the sale; the deposit is just the cash landing
      // (Clean Your Carpets was overstated ~$35K this way). Never auto-apply:
      // a human decides whether it's a true cash sale or a payout that
      // belongs matched against invoices. Other Income (interest, asset
      // sales) legitimately receives deposits and is not flagged.
      if (/^deposit$/i.test(String(line.transaction_type || "").trim())) {
        const suggested = d.target_account_id ? accountById.get(d.target_account_id) : undefined;
        const current = line.current_account_id ? accountById.get(String(line.current_account_id)) : undefined;
        const hit = [suggested, current].find((a) => a?.account_type === "Income");
        if (hit) {
          lineAnomalies.push({
            code: "deposit_to_income",
            message: `Deposit ${suggested?.account_type === "Income" ? "suggested into" : "sitting in"} revenue account "${hit.account_name}" — if this client invoices their jobs, the invoice already recorded this income and the deposit should be matched to it, not booked as new revenue. Confirm it's a true cash sale before approving.`,
          });
        }
      }
      const isHardBlocked = isHardBlock(line);
      const targetValid = !!(d.target_account_id && accountById.has(d.target_account_id));

      const confidenceFloor =
        d.source === "web_search" ? WEB_SEARCH_AUTO_FLOOR : AUTO_EXECUTE_CONFIDENCE;

      const eligibleForAuto =
        targetValid &&
        d.confidence >= confidenceFloor &&
        lineAnomalies.length === 0 &&
        !isHardBlocked &&
        autoExecuteCount < MAX_AUTO_PER_RUN;

      // Settled lines (line was already categorized — either in the rule's
      // target, or a human-chosen account) skip both buckets. We still want
      // them in processedRows so we mark them done and don't re-check next run.
      if (d.source === "already_categorized") {
        alreadyCategorizedCount++;
        processedRows.push({
          client_link_id: clientLinkId,
          qbo_line_id: line.line_id,
          qbo_transaction_id: line.transaction_id,
          run_id: result.run_id,
          auto_executed: false,
        });
        if (dryRun) {
          result.preview!.push({
            qbo_line_id: line.line_id,
            vendor_name: line.vendor_name,
            amount: line.transaction_amount,
            date: line.transaction_date,
            suggested_account_name: d.target_account_name,
            confidence: d.confidence,
            source: d.source,
            would_auto_execute: false,
            anomaly_flags: lineAnomalies,
          });
        }
        continue;
      }

      if (eligibleForAuto) {
        autoExecuteCount++;
        linesToExecute.push({ line, decision: d });
      } else {
        queueRows.push({
          client_link_id: clientLinkId,
          run_id: result.run_id,
          qbo_transaction_id: line.transaction_id,
          qbo_transaction_type: line.transaction_type,
          qbo_line_id: line.line_id,
          sync_token: line.sync_token,
          vendor_name: line.vendor_name,
          transaction_date: line.transaction_date,
          transaction_amount: line.transaction_amount,
          description: line.description,
          from_account_id: line.current_account_id,
          from_account_name: line.current_account_name,
          suggested_account_id: d.target_account_id,
          suggested_account_name: d.target_account_name,
          ai_confidence: d.confidence,
          ai_reasoning: d.reasoning,
          source: d.source,
          anomaly_flags: lineAnomalies,
          decision: "pending",
        });
      }

      processedRows.push({
        client_link_id: clientLinkId,
        qbo_line_id: line.line_id,
        qbo_transaction_id: line.transaction_id,
        run_id: result.run_id,
        auto_executed: eligibleForAuto,
      });

      if (dryRun) {
        result.preview!.push({
          qbo_line_id: line.line_id,
          vendor_name: line.vendor_name,
          amount: line.transaction_amount,
          date: line.transaction_date,
          suggested_account_name: d.target_account_name,
          confidence: d.confidence,
          source: d.source,
          would_auto_execute: eligibleForAuto,
          anomaly_flags: lineAnomalies,
        });
      }
    }

    result.auto_executed = autoExecuteCount;
    result.queued_for_review = queueRows.length;
    result.already_categorized = alreadyCategorizedCount;
    result.anomalies_count = Array.from(anomalies.values()).reduce((s, a) => s + a.length, 0);

    // 12. Cap exceeded → pause the client and re-queue everything to be safe
    if (autoExecuteCount >= MAX_AUTO_PER_RUN && !dryRun) {
      await service
        .from("client_links")
        .update({
          daily_recon_paused: true,
          daily_recon_paused_reason: `Auto-execute cap (${MAX_AUTO_PER_RUN}) hit on ${new Date().toISOString().slice(0, 10)} — review the day's batch before unpausing.`,
        } as any)
        .eq("id", clientLinkId);
    }

    // 13. Push to QBO + persist
    if (!dryRun) {
      // 13a. Auto-execute the eligible ones via QBO
      for (const { line, decision } of linesToExecute) {
        try {
          await reclassifyTransactionLines(c.qbo_realm_id, accessToken, {
            txType: line.transaction_type,
            txId: line.transaction_id,
            lineUpdates: [
              {
                line_id: line.line_id,
                new_account_id: decision.target_account_id!,
                new_account_name: decision.target_account_name!,
              },
            ],
            auditMemo: `Ironbooks daily auto-categorization (${(decision.confidence * 100).toFixed(0)}% confidence)`,
          });
        } catch (err: any) {
          // If QBO write fails, re-queue the line so the bookkeeper sees it.
          console.warn(`[daily-recon ${clientLinkId}] auto-execute failed for ${line.line_id}: ${err?.message}`);
          queueRows.push({
            client_link_id: clientLinkId,
            run_id: result.run_id,
            qbo_transaction_id: line.transaction_id,
            qbo_transaction_type: line.transaction_type,
            qbo_line_id: line.line_id,
            sync_token: line.sync_token,
            vendor_name: line.vendor_name,
            transaction_date: line.transaction_date,
            transaction_amount: line.transaction_amount,
            description: line.description,
            from_account_id: line.current_account_id,
            from_account_name: line.current_account_name,
            suggested_account_id: decision.target_account_id,
            suggested_account_name: decision.target_account_name,
            ai_confidence: decision.confidence,
            ai_reasoning: `Auto-execute failed: ${err?.message} — fell back to queue.`,
            source: decision.source,
            anomaly_flags: [{ code: "qbo_write_failed", message: String(err?.message || err) }],
            decision: "pending",
          });
          result.auto_executed--;
          result.queued_for_review++;
        }
      }

      // 13b. Bulk insert queue rows
      if (queueRows.length > 0) {
        const BATCH = 200;
        for (let i = 0; i < queueRows.length; i += BATCH) {
          await service.from("daily_review_queue" as any).insert(queueRows.slice(i, i + BATCH) as any);
        }
      }

      // 13c. Mark processed
      if (processedRows.length > 0) {
        const BATCH = 200;
        for (let i = 0; i < processedRows.length; i += BATCH) {
          await service.from("processed_qbo_lines" as any).insert(processedRows.slice(i, i + BATCH) as any);
        }
      }

      // 13d. Bump last_synced_at
      await service
        .from("client_links")
        .update({ last_synced_at: result.fetched_to } as any)
        .eq("id", clientLinkId);

      // 13e. Finalize run row
      await markRunComplete(service, result);
    }

    result.duration_ms = Date.now() - t0;
    void allLineIds; // unused — kept for future per-line audit log writes
    return result;
  } catch (err: any) {
    result.duration_ms = Date.now() - t0;
    result.status = "failed";
    result.error = err?.message || String(err);
    if (!dryRun && result.run_id) {
      await service
        .from("daily_recon_runs" as any)
        .update({
          status: "failed",
          error_message: result.error,
          duration_ms: result.duration_ms,
        } as any)
        .eq("id", result.run_id);
    }
    return result;
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

interface PipelineDecision {
  // "already_categorized" = bank rule matched but the line was either
  // already in the target account, or in some other non-default account
  // a human had categorized. We don't queue these for review — they're
  // settled. See the bank-rule branch + the queueRows skip in the loop.
  source: "kb" | "bank_rule" | "ai" | "web_search" | "unmatched" | "already_categorized";
  target_account_id: string | null;
  target_account_name: string | null;
  confidence: number;
  reasoning: string;
}

function isHardBlock(line: ReclassLine): boolean {
  const blob = `${line.vendor_name || ""} ${line.description || ""} ${line.private_note || ""}`;
  return HARD_BLOCK_PATTERNS.some((re) => re.test(blob));
}

/**
 * Per-line anomaly detection. Returns a map of line_id → flags[].
 *
 * SCAFFOLD: only the simplest rules are implemented in the first cut so we
 * can ship the infrastructure. Add more as we learn what false-positives
 * look like in production.
 */
async function detectAnomalies(
  service: ReturnType<typeof createServiceSupabase>,
  clientLinkId: string,
  newLines: ReclassLine[]
): Promise<Map<string, Array<{ code: string; message: string }>>> {
  const out = new Map<string, Array<{ code: string; message: string }>>();
  if (newLines.length === 0) return out;

  // Rule 1: Duplicate within the batch (same vendor + amount + date)
  const seen = new Map<string, ReclassLine>();
  for (const line of newLines) {
    const key = `${(line.vendor_name || "").toLowerCase()}|${Math.round(Math.abs(line.transaction_amount) * 100)}|${line.transaction_date}`;
    if (seen.has(key)) {
      addAnomaly(out, line.line_id, {
        code: "duplicate_same_day",
        message: `Same vendor/amount/date as another transaction in this batch (line ${seen.get(key)!.line_id})`,
      });
    } else {
      seen.set(key, line);
    }
  }

  // Rule 2: Round-number red flag in expense accounts ($1000, $5000, $10000)
  for (const line of newLines) {
    const abs = Math.abs(line.transaction_amount);
    if (abs >= 1000 && abs % 1000 === 0 && abs <= 50000) {
      addAnomaly(out, line.line_id, {
        code: "round_number",
        message: `Exact $${abs} transaction — common pattern for memo-needed transfers, owner draws, or estimated payments.`,
      });
    }
  }

  // TODO(when wiring more rules):
  //   - New vendor (not in bank_rules, not in KB, not in prior reclassifications)
  //   - Unusual amount (>3σ from this vendor's historical mean for this client)
  //   - Missing recurring (known monthly vendor hasn't posted in expected window)
  //   - Stale-period (transaction dated in a QBO-closed period)
  //   - Manual-entry on a bank-fed account (possible duplicate of bank feed)
  void service; // kept for future DB-backed lookups (historical means, etc.)
  void clientLinkId;

  return out;
}

function addAnomaly(
  map: Map<string, Array<{ code: string; message: string }>>,
  lineId: string,
  flag: { code: string; message: string }
) {
  const list = map.get(lineId) || [];
  list.push(flag);
  map.set(lineId, list);
}

async function markRunComplete(
  service: ReturnType<typeof createServiceSupabase>,
  result: DailyReconResult
) {
  if (!result.run_id) return;
  await service
    .from("daily_recon_runs" as any)
    .update({
      status: result.status,
      transactions_pulled: result.transactions_pulled,
      auto_executed: result.auto_executed,
      queued_for_review: result.queued_for_review,
      anomalies_count: result.anomalies_count,
      duration_ms: result.duration_ms,
    } as any)
    .eq("id", result.run_id);
}
