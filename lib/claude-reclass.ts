/**
 * Claude AI Integration for Reclassification Scrub Mode
 * -----------------------------------------------------
 * Workflow C only: AI categorizes vendor groups, mapping each to a target account
 * in the client's available COA + master COA, with confidence scoring.
 *
 * 95% confidence threshold → auto_approve
 * 70-94% → needs_review
 * <70%   → flagged
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VendorGroup } from "./qbo-reclass";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-7";

const AUTO_APPROVE_THRESHOLD = 0.95;
const NEEDS_REVIEW_THRESHOLD = 0.7;

export interface ReclassClassification {
  vendor_pattern: string;
  target_account_id: string;
  target_account_name: string;
  confidence: number;             // 0-1
  reasoning: string;
  decision: "auto_approve" | "needs_review" | "flagged";
}

export interface ReclassAnalysisResult {
  classifications: ReclassClassification[];
  unclassified: string[];         // vendor patterns AI couldn't confidently map
  warnings: string[];
  summary: string;
}

/**
 * Account available in client's QBO for reclassification (target).
 * Excludes the source account itself.
 */
export interface AvailableAccount {
  qbo_account_id: string;
  account_name: string;
  account_type: string;
  account_subtype: string;
}

const SYSTEM_PROMPT = `You are the IronBooks AI Bookkeeper performing a transaction scrub for a residential painting contractor.

The bookkeeper has selected a single source account that needs cleaning (often a dumping ground like "Uncategorized Expense" or "Ask My Accountant"). Your job: for each vendor group found in that account, map it to the correct target account in the client's COA.

CRITICAL RULES:
1. Confidence 0.95+ ONLY for obvious vendor patterns where the target account is unambiguous (Sherwin-Williams → Paint & Materials).
2. Confidence 0.70-0.94 for likely-correct mappings where context could change the answer (Home Depot → usually Job Supplies, but could be office supplies).
3. Confidence <0.70 for cases where you cannot confidently choose between 2+ targets, OR vendor is unknown.
4. The target account MUST be one of the provided "available accounts". Do NOT invent accounts.
5. Be very conservative with anything tax-sensitive: payroll, tax payments, owner draws, distributions → if unsure, low confidence.
6. The source account is what you're moving FROM. Never suggest moving back to source.
7. Reasoning must be SHORT (one sentence) and reference the vendor specifically.

For painter context, common patterns:
- Sherwin-Williams, Benjamin Moore, Dunn-Edwards, PPG, Para → "Paint & Materials" type accounts (high confidence)
- Home Depot, Lowes, Rona → "Job Supplies" usually (medium-high)
- Shell, Chevron, Esso, Petro-Canada, Costco Gas → "Fuel" / "Auto Expense" type accounts (high)
- Gusto, ADP, Wagepoint, Payworks → Payroll-related (LOW confidence, flag for human)
- State Farm, Intact, Aviva, Wawanesa → Insurance accounts (high)
- Verizon, Rogers, Bell, Telus → Telecom/Utilities (high)
- Stripe, Square, Helcim, PayPal → Revenue/Merchant fees (medium - context-dependent)
- IRS, CRA, State/Provincial tax authorities → FLAG, never confident
- Unknown one-off vendors → low confidence, let bookkeeper decide

Return STRICTLY valid JSON:
{
  "classifications": [
    {
      "vendor_pattern": "string (matches input)",
      "target_account_id": "string (QBO ID from available_accounts)",
      "target_account_name": "string (matches available_accounts name)",
      "confidence": 0.00-1.00,
      "reasoning": "string (one sentence)"
    }
  ],
  "unclassified": ["vendor patterns you couldn't map"],
  "warnings": ["structural concerns"],
  "summary": "one paragraph overview"
}

No markdown fences, no preamble. Just the JSON.`;

export async function classifyVendorGroups(params: {
  clientName: string;
  jurisdiction: "US" | "CA";
  stateProvince: string;
  sourceAccountName: string;
  vendorGroups: VendorGroup[];
  availableAccounts: AvailableAccount[];
}): Promise<ReclassAnalysisResult> {
  // Compact input — Claude doesn't need every transaction, just the vendor summary
  const compactGroups = params.vendorGroups.map((g) => ({
    vendor: g.vendor_pattern,
    sample_name: g.display_name,
    tx_count: g.lines.length,
    total_amount: Math.round(g.total_amount),
    date_range: `${g.earliest_date} to ${g.latest_date}`,
    // Send up to 3 sample memos to give context
    sample_descriptions: g.lines
      .slice(0, 3)
      .map((l) => l.description)
      .filter((d) => d && d.length > 0)
      .slice(0, 3),
  }));

  const compactAccounts = params.availableAccounts.map((a) => ({
    id: a.qbo_account_id,
    name: a.account_name,
    type: a.account_type,
    subtype: a.account_subtype,
  }));

  const userMessage = `
CLIENT: ${params.clientName}
JURISDICTION: ${params.jurisdiction} (${params.stateProvince})
INDUSTRY: Residential Painting Contractor
SOURCE ACCOUNT being scrubbed: "${params.sourceAccountName}"

===== AVAILABLE TARGET ACCOUNTS =====
${JSON.stringify(compactAccounts, null, 2)}

===== VENDOR GROUPS TO CLASSIFY (${compactGroups.length} groups) =====
${JSON.stringify(compactGroups, null, 2)}

Classify each vendor group. Return the structured JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 12000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((c) => c.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: {
    classifications: Array<{
      vendor_pattern: string;
      target_account_id: string;
      target_account_name: string;
      confidence: number;
      reasoning: string;
    }>;
    unclassified?: string[];
    warnings?: string[];
    summary?: string;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    throw new Error(
      `Failed to parse Claude reclass output: ${err.message}\nResponse: ${cleaned.slice(0, 500)}`
    );
  }

  // Validate + derive decisions
  const validAccountIds = new Set(params.availableAccounts.map((a) => a.qbo_account_id));
  const warnings = [...(parsed.warnings || [])];
  const classifications: ReclassClassification[] = [];
  const unclassified = [...(parsed.unclassified || [])];

  for (const c of parsed.classifications) {
    if (!validAccountIds.has(c.target_account_id)) {
      warnings.push(`Dropped "${c.vendor_pattern}" → invalid target ID "${c.target_account_id}"`);
      unclassified.push(c.vendor_pattern);
      continue;
    }

    const confidence = Math.max(0, Math.min(1, c.confidence));

    let decision: ReclassClassification["decision"];
    if (confidence >= AUTO_APPROVE_THRESHOLD) decision = "auto_approve";
    else if (confidence >= NEEDS_REVIEW_THRESHOLD) decision = "needs_review";
    else decision = "flagged";

    // Force-flag sensitive vendors regardless of confidence
    const isSensitive =
      /payroll|tax|irs|cra|owner|draw|distribution|gusto|adp|wagepoint|payworks/i.test(
        c.vendor_pattern + " " + c.target_account_name
      );
    if (isSensitive && decision === "auto_approve") {
      decision = "needs_review";
    }

    classifications.push({
      vendor_pattern: c.vendor_pattern,
      target_account_id: c.target_account_id,
      target_account_name: c.target_account_name,
      confidence,
      reasoning: c.reasoning,
      decision,
    });
  }

  return {
    classifications,
    unclassified,
    warnings,
    summary: parsed.summary || "",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FULL CATEGORIZATION — line-level AI classification against the new COA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Patterns that should always route to "Uncategorized" (decision = flagged)
 * regardless of AI confidence. E-transfers and peer payment apps without
 * a clear vendor or memo cannot be categorized blind — human review required.
 */
const ETRANSFER_PATTERNS = [
  /e-?transfer/i,
  /interac/i,
  /\be-?tfr\b/i,
  /\bemt\b/i,
  /venmo/i,
  /zelle/i,
  /cash\s*app/i,
  /wire\s*transfer/i,
  /etfr/i,
];

export interface FullCategorizationLine {
  /** Stable identifier the caller uses to correlate back to its source row */
  ref_id: string;
  vendor_name: string;
  amount: number;             // signed
  date: string;               // YYYY-MM-DD
  description: string;        // line description
  private_note: string;       // transaction memo
  current_account_name: string;
}

export interface FullCategorizationDecision {
  ref_id: string;
  target_account_id: string | null;
  target_account_name: string | null;
  confidence: number;
  reasoning: string;
  decision: "auto_approve" | "needs_review" | "flagged";
  flagged_reason?: string;
}

const FULL_CAT_SYSTEM_PROMPT = `You are the IronBooks AI Bookkeeper running full-COA transaction categorization for a residential painting contractor.

You'll receive a batch of transaction lines (vendor, amount, date, description, current account) and the full list of valid target accounts in the client's NEW Chart of Accounts. For each line, pick the BEST target account and a confidence score.

CRITICAL RULES:
1. The target_account_id MUST be one of the provided available_accounts. Never invent.
2. Confidence 0.95+ for obvious vendor → account mappings (Sherwin-Williams → Paint & Materials).
3. Confidence 0.80-0.94 for likely-correct mappings.
4. Confidence 0.50-0.79 for plausible but ambiguous.
5. Confidence <0.50 means you can't reasonably decide — leave target_account_id empty.
6. Be conservative with payroll, tax, owner draws, distributions, loans → low confidence.
7. Use the vendor + description together for context; don't rely on vendor alone.
8. Reasoning is short (one sentence), specific to the vendor.

Painter-specific quick map:
- Sherwin-Williams, Benjamin Moore, Dunn-Edwards, PPG, Para → Paint & Materials
- Home Depot, Lowes, Rona → Job Supplies (usually) or Small Tools (if itemized)
- Shell, Chevron, Esso, Petro-Canada, Costco Gas → Fuel – Admin & Sales Vehicles (admin) or Direct Fuel Allocation (crew)
- Gusto, ADP, Wagepoint, Payworks → Payroll-related (LOW confidence)
- State Farm, Intact, Aviva, Wawanesa → Insurance (high)
- Verizon, Rogers, Bell, Telus, Comcast → Software Subscriptions or Utilities
- Stripe, Square, Helcim, PayPal → Painting Revenue (net) or Bank Charges
- IRS, CRA, federal/provincial revenue authorities → LOW confidence, flag

Return STRICTLY valid JSON:
{
  "decisions": [
    {
      "ref_id": "string (echoes input)",
      "target_account_id": "string (from available_accounts, or empty string)",
      "target_account_name": "string (matches account_name)",
      "confidence": 0.00-1.00,
      "reasoning": "string"
    }
  ]
}

No markdown fences, no preamble. Just the JSON.`;

const FULL_CAT_BATCH_SIZE = 30;

/**
 * Classify every transaction line against the new COA.
 * Auto-approve rule: confidence >= 0.80 AND |amount| < threshold AND not e-transfer.
 * E-transfer/Venmo/Zelle without clear vendor → forced to "flagged".
 */
export async function categorizeAllTransactions(params: {
  clientName: string;
  jurisdiction: "US" | "CA";
  stateProvince: string;
  lines: FullCategorizationLine[];
  availableAccounts: AvailableAccount[];
  autoApproveThreshold: number;
}): Promise<{
  decisions: FullCategorizationDecision[];
  warnings: string[];
  summary: string;
}> {
  const allDecisions: FullCategorizationDecision[] = [];
  const warnings: string[] = [];

  // E-transfer pre-routing: anything matching is forced to flagged with target=null
  const linesToClassify: FullCategorizationLine[] = [];
  for (const line of params.lines) {
    const haystack = `${line.vendor_name} ${line.description} ${line.private_note}`;
    const isETransfer = ETRANSFER_PATTERNS.some((re) => re.test(haystack));
    const hasNoClearVendor = !line.vendor_name || line.vendor_name.toLowerCase() === "unknown vendor";
    if (isETransfer && hasNoClearVendor) {
      allDecisions.push({
        ref_id: line.ref_id,
        target_account_id: null,
        target_account_name: null,
        confidence: 0,
        reasoning: "E-transfer / peer payment without a clear vendor — needs manual placement.",
        decision: "flagged",
        flagged_reason: "Uncategorized — peer payment (e-transfer/Venmo/Zelle) with no vendor info",
      });
      continue;
    }
    linesToClassify.push(line);
  }

  // Compact account list shared across batches
  const compactAccounts = params.availableAccounts.map((a) => ({
    id: a.qbo_account_id,
    name: a.account_name,
    type: a.account_type,
    subtype: a.account_subtype,
  }));

  // Build account lookup for validation
  const accountById = new Map(params.availableAccounts.map((a) => [a.qbo_account_id, a]));

  // Batch through Claude
  for (let i = 0; i < linesToClassify.length; i += FULL_CAT_BATCH_SIZE) {
    const batch = linesToClassify.slice(i, i + FULL_CAT_BATCH_SIZE);
    const compactBatch = batch.map((l) => ({
      ref_id: l.ref_id,
      vendor: l.vendor_name,
      amount: l.amount,
      date: l.date,
      desc: l.description || "",
      memo: l.private_note || "",
      current_account: l.current_account_name,
    }));

    const userMessage = `CLIENT: ${params.clientName}
JURISDICTION: ${params.jurisdiction} (${params.stateProvince})
INDUSTRY: Residential Painting Contractor

===== AVAILABLE TARGET ACCOUNTS (new COA) =====
${JSON.stringify(compactAccounts, null, 2)}

===== TRANSACTION LINES (this batch: ${batch.length}) =====
${JSON.stringify(compactBatch, null, 2)}

Classify each line. Return JSON only.`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: FULL_CAT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      warnings.push(`Batch ${i / FULL_CAT_BATCH_SIZE + 1}: no text response from Claude`);
      continue;
    }
    const raw = textBlock.text
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();

    let parsed: { decisions: Array<{ ref_id: string; target_account_id: string; target_account_name: string; confidence: number; reasoning: string }> };
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      warnings.push(`Batch ${i / FULL_CAT_BATCH_SIZE + 1}: JSON parse failed (${err.message})`);
      continue;
    }

    for (const d of parsed.decisions || []) {
      const sourceLine = batch.find((l) => l.ref_id === d.ref_id);
      if (!sourceLine) continue;

      // Validate target exists
      const targetAccount = d.target_account_id ? accountById.get(d.target_account_id) : null;
      const confidence = Math.max(0, Math.min(1, d.confidence));
      const absAmount = Math.abs(sourceLine.amount);

      let decision: "auto_approve" | "needs_review" | "flagged";
      let target_id: string | null = targetAccount?.qbo_account_id || null;
      let target_name: string | null = targetAccount?.account_name || null;

      if (!targetAccount) {
        decision = "flagged";
        target_id = null;
        target_name = null;
      } else if (confidence >= 0.80 && absAmount < params.autoApproveThreshold) {
        decision = "auto_approve";
      } else {
        decision = "needs_review";
      }

      allDecisions.push({
        ref_id: d.ref_id,
        target_account_id: target_id,
        target_account_name: target_name,
        confidence,
        reasoning: d.reasoning || "",
        decision,
        flagged_reason: !targetAccount ? "AI could not confidently pick a target account" : undefined,
      });
    }
  }

  const counts = {
    auto: allDecisions.filter((d) => d.decision === "auto_approve").length,
    review: allDecisions.filter((d) => d.decision === "needs_review").length,
    flagged: allDecisions.filter((d) => d.decision === "flagged").length,
  };

  return {
    decisions: allDecisions,
    warnings,
    summary: `Classified ${allDecisions.length} lines: ${counts.auto} auto-approved (<${params.autoApproveThreshold}), ${counts.review} needs review, ${counts.flagged} flagged for manual placement.`,
  };
}
