/**
 * Claude AI Integration for COA Cleanup
 * --------------------------------------
 * Sends the client's QBO Chart of Accounts to Claude along with the Ironbooks
 * Master COA template. Claude returns structured suggestions for each account:
 *   - keep / rename / delete / flag
 *   - confidence score
 *   - reasoning
 *
 * Uses Claude Opus for the analysis (best at structured reasoning + nuance).
 *
 * Requires env vars:
 *  - ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import type { QBOAccount } from './qbo';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-opus-4-7';

// ============== TYPES ==============

export interface MasterCOAEntry {
  account_name: string;
  parent_account_name: string | null;
  is_parent: boolean;
  qbo_account_type: string;
  qbo_account_subtype: string;
  section: string;
  notes: string;
  is_required: boolean;
  tax_treatment: any;
}

export interface AISuggestion {
  qbo_account_id: string;
  current_name: string;
  action: 'keep' | 'rename' | 'delete' | 'flag' | 'merge';
  target_master_account?: string;     // for rename/merge: which master account to map to
  new_parent_account?: string;
  confidence: number;
  reasoning: string;
  flag_reason?: string;
}

export interface AnalysisResult {
  suggestions: AISuggestion[];
  missing_required_accounts: string[];      // master accounts not in client's COA
  warnings: string[];
  summary: string;
}

// ============== SYSTEM PROMPT ==============

const SYSTEM_PROMPT = `You are the Ironbooks AI Bookkeeper — a senior accountant specializing in painting contractors.

Your job is to map each account in a painter's QuickBooks COA to the Ironbooks Master COA template as aggressively as possible. The goal is to get 95%+ of accounts remapped, not flagged. Flags should be rare and reserved for genuine uncertainty.

You will receive:
1. The Ironbooks Master COA (the target standard)
2. The client's current QBO COA

For each client account, choose ONE action:
- KEEP: name already matches a master account exactly (or is close enough it needs no change)
- RENAME: rename to a specific master account (use this aggressively — when in doubt, rename)
- DELETE: zero transactions AND no reasonable master match (unused QBO defaults)
- FLAG: genuine human review required (see narrow list below)

═══ RENAME — USE THIS AGGRESSIVELY ═══
If a client account is semantically related to any master account, RENAME it.
Do NOT flag just because the name isn't a perfect match.
The QBO type/subtype mismatch alone is NOT a reason to flag — it's a reason to rename.

Common mappings you must apply:
  "Bank Charges & Fees", "Bank Service Charges"  → "Accounting & Bookkeeping"
  "Coaching & Development", "Training"            → "Continuing Education / Professional Development"
  "Meals and Entertainment", "Entertainment"      → "Meals (50% deductible)"
  "Auto - Repairs", "Car Maintenance", "Vehicle Maint" → "Vehicle Repairs"
  "Gas", "Gasoline", "Fuel", "Gas & Oil"          → "Fuel – Overhead"
  "Vehicle Lease", "Auto Lease", "Truck Lease"    → "Vehicle Lease"
  "Vehicle Loan Interest", "Auto Loan Interest", "Car Loan Interest" → "Vehicle Loan Interest"
  "Gifts", "Client Gifts", "Employee Gifts"       → "Gifts"
  "Business Taxes", "Taxes"                       → "Taxes"
  "Business License", "Licenses", "License & Fees" → "Licenses"
  "Workers Comp Insurance", "Workman's Comp", "WCB Insurance" → "Workman's Comp Insurance"
  "Direct Fuel", "Field Fuel"                     → "Direct Fuel Allocation"
  "Commissions", "Sales Commission"               → "Sales Team Payroll/Commission"
  "Advertising", "Google Ads", "Facebook Ads"     → "Online Advertising – Google Ads / Social Media Marketing"
  "Subcontractors", "Contractors", "Subs"         → "Subcontractors – Painting"
  "Labor", "Field Labor", "Crew Labor"            → "Direct Field Labor – Painting"
  "Paint", "Paint & Primer", "Materials"          → "Paint & Materials"
  "Tools", "Tool Supplies"                        → "Small Tools"
  "Rent", "Office Rent", "Studio Rent"            → "Office Rent"
  "Phone", "Cell Phone", "Internet"               → "Software Subscriptions" (if software/tech) or "Office Supplies"
  "General Liability", "GL Insurance", "CGL"      → "CGL Insurance"
  "Health Insurance", "Medical"                   → "Health Insurance – Owner"
  "Workers Comp", "WCB"                           → "Workers Compensation – Field" or "Workers Compensation – Admin"
  "Accounting", "Bookkeeping", "CPA"              → "Accounting & Bookkeeping"
  "Legal", "Attorney"                             → "Legal Fees"
  "Depreciation", "Amortization"                  → "Depreciation"
  "Interest", "Loan Interest", "Bank Interest"    → "Interest Expense"
  "Equipment Rental", "Tool Rental"               → "Equipment Rental (Job-Specific)"
  "Disposal", "Dump Fees", "Waste"                → "Job Disposal Fees"
  "Permits", "Permit & License"                   → "Permit Fees"
  "Travel", "Airfare", "Hotel"                    → "Travel – Airfare & Lodging"
  "Conferences", "Trade Show"                     → "Trade Shows / Industry Events"
  "Networking", "BNI", "Chamber"                  → "Networking Events"
  "Software", "Apps", "Subscriptions", "SaaS"     → "Software Subscriptions"
  "Marketing Tools", "CRM", "Jobber"              → "Marketing Tools"
  "Payroll Tax", "Employer Taxes"                 → "Employer Payroll Taxes – Field" or "Employer Payroll Taxes – Admin & Sales"
  "Employee Benefits", "Benefits"                 → "Employee Benefits – Admin & Sales"
  "Retirement", "401k", "RRSP", "SEP IRA"         → "Retirement Contributions – Owner"
  "Income", "Revenue", "Sales" (painting)         → "Painting Revenue"
  "Remodel", "Renovation Revenue"                 → "Remodeling Revenue"
  "Owner Salary", "Owner Wages", "Owner Pay", "Officer Salary", "Officer Compensation" → "Owner's Payroll"
  "Owner Draw", "Owner's Draw", "Owner Distribution", "Distributions", "Member Draw", "Shareholder Distribution" → "Owner's Draw"

═══ OWNER PAY — SPLIT DRAW FROM SALARY (CRITICAL) ═══
Owner compensation has two completely different treatments. NEVER conflate them:
  • Owner SALARY / WAGES (owner is on payroll) = operating EXPENSE, above the
    net-profit line (a fixed cost). Map to "Owner's Payroll".
  • Owner DRAW / DISTRIBUTION (owner taking profit out) = EQUITY, below the
    net-profit line. It is NOT an expense. Map to "Owner's Draw".
Hard rules:
  - NEVER map a draw / distribution to an expense account.
  - NEVER map salary / wages to equity.
  - If an account COMBINES them (e.g. "Owner Draw / Salary", a generic "Owner Pay"),
    OR you can see both kinds of activity in one account, OR a draw is sitting in
    expenses / salary is sitting in equity → set action "flag" with flag_reason:
    "Split owner draw (equity) from owner salary (expense) and reclassify the transactions."
    This must be flagged on every cleanup so it gets reclassified going forward.

═══ DELETE — ZERO TRANSACTIONS ONLY ═══
DELETE if ALL of these are true:
  - transaction_count is 0 (zero)
  - The account is a known unused QBO default OR has no reasonable master match

Known QBO defaults to DELETE (when 0 transactions):
  "Ask My Accountant", "Billable Expense Income", "Charitable Contributions",
  "Charitable", "Opening Balance Equity", "Reconciliation Discrepancies",
  "Payroll Expenses", "Payroll Liabilities", "Sales of Product Income",
  "Uncategorized Asset", "Uncategorized Expense", "Uncategorized Income",
  "Miscellaneous" (when 0 txns and no match), "Other Miscellaneous"

═══ FLAG — NARROW LIST ONLY ═══
Only FLAG these specific situations:
  1. Account name contains: "Personal", "Note Payable", "Shareholder Loan" (genuine
     equity / related-party items). For "Owner"/"Draw"/"Distribution"/salary, apply the
     OWNER PAY rule above (map salary→expense, draw→equity; flag only the mixed case).
  2. Account type is Equity or Liability AND CurrentBalance is not zero
  3. Account has transactions AND you genuinely cannot determine any master account mapping
  4. Account appears to be a duplicate of another client account mapping to the same master (rare — system handles this)
  5. A combined "Taxes & Licenses" account → flag to split into "Taxes" and "Licenses" and reclassify

DO NOT flag for: type/subtype mismatches, missing master equivalents, name ambiguity you can resolve with reasonable judgment.

═══ CONFIDENCE SCORES ═══
0.95+ : Exact name match or in the common mappings list above
0.85–0.94 : Clear semantic match, minor name variation
0.70–0.84 : Reasonable match, some ambiguity
Below 0.70 : Use FLAG with a specific reason

═══ OUTPUT RULES ═══
- Reasoning: max 10 words, specific to this account. No filler.
- NEVER include markdown, code fences, or text outside the JSON.
- Return STRICTLY valid JSON:

{
  "suggestions": [
    {
      "qbo_account_id": "string",
      "current_name": "string",
      "action": "keep" | "rename" | "delete" | "flag",
      "target_master_account": "string (required for rename)",
      "new_parent_account": "string (only if hierarchy changes)",
      "confidence": 0.00-1.00,
      "reasoning": "string",
      "flag_reason": "string (only for flag)"
    }
  ],
  "missing_required_accounts": [],
  "warnings": [],
  "summary": "one paragraph"
}`;

// ============== RETRY HELPER ==============

/**
 * Retry a Claude API call on transient 529 overloaded errors with exponential backoff.
 * Any other error (auth, invalid input, etc.) is re-thrown immediately.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const isOverloaded =
        err?.status === 529 ||
        err?.error?.type === "overloaded_error" ||
        /overloaded/i.test(err?.message || "");
      if (!isOverloaded || attempt === maxRetries) throw err;
      const delayMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
      console.warn(
        `[claude] Overloaded (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${delayMs / 1000}s`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ============== ANALYZE ==============

/**
 * Maximum number of client accounts to send to Claude in a single API call.
 * Each batch produces ~80 output tokens/account; at 40 accounts that's ~3200
 * output tokens, well within the 16K max_tokens budget.
 * 176 accounts → 5 batches; 300 accounts → 8 batches; etc.
 */
const BATCH_SIZE = 40;

export async function analyzeCOA(params: {
  clientName: string;
  jurisdiction: 'US' | 'CA';
  stateProvince: string;
  clientAccounts: Array<QBOAccount & { transaction_count?: number }>;
  masterCOA: MasterCOAEntry[];
}): Promise<AnalysisResult> {
  // Compact master COA once (constant across all batches)
  const compactMaster = params.masterCOA.map(m => ({
    name: m.account_name,
    parent: m.parent_account_name,
    is_parent: m.is_parent,
    type: m.qbo_account_type,
    subtype: m.qbo_account_subtype,
    section: m.section,
    required: m.is_required,
    tax_note: m.tax_treatment?.note,
  }));

  // Single batch path — small clients
  if (params.clientAccounts.length <= BATCH_SIZE) {
    const result = await _analyzeBatch({
      clientName: params.clientName,
      jurisdiction: params.jurisdiction,
      stateProvince: params.stateProvince,
      batchAccounts: params.clientAccounts,
      compactMaster,
      batchInfo: null,
    });
    return validateAnalysis(result, params.clientAccounts);
  }

  // Multi-batch path — split client COA into chunks
  const batches: Array<typeof params.clientAccounts> = [];
  for (let i = 0; i < params.clientAccounts.length; i += BATCH_SIZE) {
    batches.push(params.clientAccounts.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `[analyzeCOA] Splitting ${params.clientAccounts.length} accounts into ${batches.length} batches of up to ${BATCH_SIZE}`
  );

  // Run batches in PARALLEL with a concurrency cap. Each batch is an
  // independent Claude call analyzing a disjoint chunk of accounts —
  // there's no inter-batch dependency. Previously this ran one batch at
  // a time, making a 200-account COA take ~4× longer than necessary.
  // Concurrency 3 stays well inside Anthropic's per-minute rate limit
  // and avoids one slow batch blocking the whole train.
  const CONCURRENCY = 3;
  const batchResults: AnalysisResult[] = new Array(batches.length);
  async function runBatch(idx: number) {
    console.log(`[analyzeCOA] Running batch ${idx + 1}/${batches.length} (${batches[idx].length} accounts)...`);
    const t0 = Date.now();
    const result = await _analyzeBatch({
      clientName: params.clientName,
      jurisdiction: params.jurisdiction,
      stateProvince: params.stateProvince,
      batchAccounts: batches[idx],
      compactMaster,
      batchInfo: { current: idx + 1, total: batches.length },
    });
    console.log(`[analyzeCOA] Batch ${idx + 1} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    batchResults[idx] = result;
  }

  // Simple bounded-concurrency queue
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= batches.length) return;
      await runBatch(idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));

  // Merge all batch outputs into a single AnalysisResult
  const merged = mergeAnalysisResults(batchResults, params.masterCOA, params.clientAccounts);
  return validateAnalysis(merged, params.clientAccounts);
}

/**
 * Run one Claude call for a subset of the client's accounts.
 * Pure - no DB writes, no merging - just sends accounts and parses the response.
 */
async function _analyzeBatch(args: {
  clientName: string;
  jurisdiction: 'US' | 'CA';
  stateProvince: string;
  batchAccounts: Array<QBOAccount & { transaction_count?: number }>;
  compactMaster: any[];
  batchInfo: { current: number; total: number } | null;
}): Promise<AnalysisResult> {
  const compactClient = args.batchAccounts.map(a => ({
    id: a.Id,
    name: a.Name,
    type: a.AccountType,
    subtype: a.AccountSubType,
    parent: a.ParentRef?.name,
    balance: a.CurrentBalance,
    tx_count: a.transaction_count ?? 0,
    active: a.Active,
  }));

  const batchHeader = args.batchInfo
    ? `\nBATCH: ${args.batchInfo.current} of ${args.batchInfo.total} (this batch has ${args.batchAccounts.length} accounts; analyze ONLY these)`
    : '';

  const userMessage = `
CLIENT: ${args.clientName}
JURISDICTION: ${args.jurisdiction} (${args.stateProvince})
INDUSTRY: Residential Painting Contractor${batchHeader}

===== IRONBOOKS MASTER COA (${args.jurisdiction}) =====
${JSON.stringify(args.compactMaster, null, 2)}

===== CLIENT'S CURRENT COA (from QuickBooks) =====
${JSON.stringify(compactClient, null, 2)}

Analyze each client account in this batch and return your structured JSON response.
If this is a batch, do NOT worry about missing_required_accounts — that's calculated separately. Return [] for missing_required_accounts.`.trim();

  const response = await withRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })
  );

  if (response.stop_reason === 'max_tokens') {
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const where = args.batchInfo ? `batch ${args.batchInfo.current}/${args.batchInfo.total}` : 'single call';
    throw new Error(
      `Claude hit the max_tokens cap during analysis (${where}, ${args.batchAccounts.length} accounts, used ${outputTokens} output tokens, ${inputTokens} input). ` +
      `Reduce BATCH_SIZE in lib/claude.ts.`
    );
  }

  const textBlock = response.content.find(c => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  const raw = textBlock.text.trim();
  const cleaned = raw
    .replace(/^```json\s*/, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned) as AnalysisResult;
  } catch (err: any) {
    const preview = cleaned.length > 1000
      ? cleaned.slice(0, 500) + '\n...[truncated]...\n' + cleaned.slice(-500)
      : cleaned;
    const where = args.batchInfo ? `batch ${args.batchInfo.current}/${args.batchInfo.total}` : 'single call';
    throw new Error(
      `Failed to parse Claude response as JSON (${where}): ${err.message}\n` +
      `Output tokens: ${response.usage?.output_tokens ?? 'unknown'} of 16000. Stop reason: ${response.stop_reason}\n\n` +
      `Response preview:\n${preview}`
    );
  }
}

/**
 * Merge per-batch results into a single AnalysisResult.
 * - Concatenates all suggestions.
 * - Deduplicates warnings.
 * - Computes missing_required_accounts deterministically (no AI needed).
 * - Synthesizes a summary.
 */
function mergeAnalysisResults(
  batchResults: AnalysisResult[],
  masterCOA: MasterCOAEntry[],
  allClientAccounts: Array<QBOAccount & { transaction_count?: number }>
): AnalysisResult {
  const allSuggestions: AISuggestion[] = batchResults.flatMap(r => r.suggestions || []);
  const allWarnings: string[] = Array.from(
    new Set(batchResults.flatMap(r => r.warnings || []))
  );

  // Compute missing master accounts deterministically.
  // JP audit (2026-07-10): apply the FULL standard chart to every client, not
  // just the is_required subset. Reason — the vendor KB and reclass target
  // master account names that were never created unless flagged required, so
  // categorization silently fell back to Uncategorized (the fuel bug). Every
  // non-parent master leaf is now created (parents auto-created by the executor
  // as needed). A leaf is "missing" if:
  //   - No client account already has that exact name, AND
  //   - No suggestion is renaming to it
  const clientNamesLower = new Set(
    allClientAccounts.map(a => (a.Name || '').toLowerCase().trim())
  );
  const renameTargetsLower = new Set(
    allSuggestions
      .filter(s => s.action === 'rename' && s.target_master_account)
      .map(s => (s.target_master_account || '').toLowerCase().trim())
  );

  const missing = masterCOA
    .filter(m => !m.is_parent)
    .filter(m => {
      const n = m.account_name.toLowerCase().trim();
      return !clientNamesLower.has(n) && !renameTargetsLower.has(n);
    })
    .map(m => m.account_name);

  const counts = {
    keep: allSuggestions.filter(s => s.action === 'keep').length,
    rename: allSuggestions.filter(s => s.action === 'rename').length,
    delete: allSuggestions.filter(s => s.action === 'delete').length,
    flag: allSuggestions.filter(s => s.action === 'flag').length,
    merge: allSuggestions.filter(s => s.action === 'merge').length,
  };

  const summary =
    `Analyzed ${allSuggestions.length} client accounts across ${batchResults.length} batches. ` +
    `Recommendations: ${counts.keep} keep, ${counts.rename} rename, ${counts.merge} merge, ${counts.delete} delete, ${counts.flag} flag for review. ` +
    `${missing.length} standard master accounts are missing and will be created (full chart applied).`;

  return {
    suggestions: allSuggestions,
    missing_required_accounts: missing,
    warnings: allWarnings,
    summary,
  };
}

// ============== DUPLICATE MAPPING RESOLUTION ==============

/**
 * When multiple client accounts map to the same master account, only one can be
 * renamed to that target — QBO rejects duplicate names. The highest-confidence
 * match becomes the primary RENAME; all others become MERGE (their transactions
 * will be moved into the renamed account at execution time).
 */
function resolveDuplicateMappings(suggestions: AISuggestion[]): AISuggestion[] {
  // Group rename suggestions by their target master account (case-insensitive)
  const byTarget = new Map<string, AISuggestion[]>();
  for (const s of suggestions) {
    if (s.action === 'rename' && s.target_master_account) {
      const key = s.target_master_account.trim().toLowerCase();
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.push(s);
    }
  }

  for (const [, group] of byTarget) {
    if (group.length < 2) continue;
    // Sort descending by confidence — highest confidence keeps the rename
    group.sort((a, b) => b.confidence - a.confidence);
    // First entry stays as rename; the rest become merges
    for (let i = 1; i < group.length; i++) {
      group[i].action = 'merge';
      group[i].flag_reason = `Duplicate mapping — will merge into "${group[0].target_master_account}" (primary: "${group[0].current_name}")`;
    }
  }

  return suggestions;
}

// ============== VALIDATION ==============

/**
 * Sanity-check Claude's output before we trust it for execution.
 * Auto-corrects unsafe suggestions (e.g., delete with transactions → flag).
 */
function validateAnalysis(
  analysis: AnalysisResult,
  clientAccounts: Array<QBOAccount & { transaction_count?: number }>
): AnalysisResult {
  // Resolve duplicate target mappings before safety checks so the merge action
  // is set correctly before we inspect each suggestion below.
  analysis.suggestions = resolveDuplicateMappings(analysis.suggestions);

  const accountById = new Map(clientAccounts.map(a => [a.Id, a]));
  const warnings = [...(analysis.warnings || [])];

  for (const s of analysis.suggestions) {
    const account = accountById.get(s.qbo_account_id);
    if (!account) continue;

    const txCount = account.transaction_count ?? 0;

    // SAFETY: never delete with transactions
    if (s.action === 'delete' && txCount > 0) {
      warnings.push(`Forced flag: "${s.current_name}" had delete suggested but has ${txCount} transactions`);
      s.action = 'flag';
      s.flag_reason = `Has ${txCount} transactions - cannot delete`;
      s.confidence = Math.min(s.confidence, 0.5);
    }

    // SAFETY: flag anything Equity, Liability, large-balance
    if (account.Classification === 'Equity' || account.Classification === 'Liability') {
      if (s.action !== 'flag') {
        warnings.push(`Forced flag: "${s.current_name}" is ${account.Classification} - needs Lisa review`);
        s.action = 'flag';
        s.flag_reason = `${account.Classification} account requires manual review`;
      }
    }

    // SAFETY: flag large balances
    if (Math.abs(account.CurrentBalance) > 50000 && s.action === 'rename') {
      warnings.push(`Caution: "${s.current_name}" has $${account.CurrentBalance.toLocaleString()} balance`);
    }

    // SAFETY: clamp confidence
    s.confidence = Math.max(0, Math.min(1, s.confidence));

    // SAFETY: rename/merge requires target
    if ((s.action === 'rename' || s.action === 'merge') && !s.target_master_account) {
      s.action = 'flag';
      s.flag_reason = 'Rename/merge suggested but no target master account specified';
    }
  }

  return { ...analysis, warnings };
}

// ============== SINGLE ACCOUNT REVIEW ==============

/**
 * Re-analyze a single flagged account with more context.
 * Used when Lisa is reviewing flagged items and wants a deeper opinion.
 */
export async function deepReviewAccount(params: {
  account: QBOAccount & { transaction_count?: number };
  recentTransactions: Array<{ date: string; amount: number; description: string }>;
  jurisdiction: 'US' | 'CA';
  masterCOA: MasterCOAEntry[];
}): Promise<{
  recommended_action: 'keep' | 'rename' | 'delete' | 'flag' | 'manual_split';
  recommended_target?: string;
  reasoning: string;
  considerations: string[];
}> {
  const userMessage = `Analyze this flagged account in detail:

ACCOUNT:
${JSON.stringify({
    name: params.account.Name,
    type: params.account.AccountType,
    subtype: params.account.AccountSubType,
    balance: params.account.CurrentBalance,
    classification: params.account.Classification,
    tx_count: params.account.transaction_count,
  }, null, 2)}

RECENT TRANSACTIONS (last 20):
${JSON.stringify(params.recentTransactions.slice(0, 20), null, 2)}

AVAILABLE MASTER ACCOUNTS:
${params.masterCOA.filter(m => !m.is_parent).map(m => m.account_name).join(', ')}

OWNER-PAY RULE (critical): Owner salary/wages = operating EXPENSE (above net profit) → "Owner's Payroll". Owner draw/distribution = EQUITY (below net profit, NOT an expense) → "Owner's Draw". If the transactions mix both, recommend "manual_split" and note the draws must be reclassified to equity and the salary to expense.

Provide your recommendation as JSON:
{
  "recommended_action": "keep" | "rename" | "delete" | "flag" | "manual_split",
  "recommended_target": "string (if rename)",
  "reasoning": "2-3 sentences explaining your call",
  "considerations": ["important factors Lisa should know"]
}`;

  const response = await withRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: userMessage }],
    })
  );

  const textBlock = response.content.find(c => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  const cleaned = textBlock.text
    .replace(/^```json\s*/, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  return JSON.parse(cleaned);
}
