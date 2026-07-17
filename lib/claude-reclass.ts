/**
 * Claude AI Integration for Reclassification Scrub Mode
 * -----------------------------------------------------
 * Workflow C only: AI categorizes vendor groups, mapping each to a target account
 * in the client's available COA + master COA, with confidence scoring.
 *
 * 95% confidence threshold → auto_approve
 * <95%  → needs_review (bookkeeper approves during the reclass review —
 *         low-confidence items are NOT escalated to the senior /flagged
 *         queue; that buried managers in 600+ auto-suggestions)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VendorGroup } from "./qbo-reclass";
import { lookupVendor, normalizeVendorForLookup } from "./vendor-knowledge";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-8";

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
      const delayMs = Math.pow(2, attempt + 1) * 1000;
      console.warn(`[claude-reclass] Overloaded (attempt ${attempt + 1}/${maxRetries + 1}) — retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

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

const SYSTEM_PROMPT = `You are the Ironbooks AI Bookkeeper performing a transaction scrub for a residential painting contractor.

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

  const response = await withRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 12000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })
  );

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

    // Two tiers only: high confidence auto-approves, everything else goes
    // to the bookkeeper's needs-review tab in the reclass flow. The old
    // third tier (<70% → "flagged") escalated every low-confidence AI
    // guess to the senior /flagged queue — hundreds of items nobody
    // actioned. The bookkeeper running the reclass decides; "flagged" is
    // reserved for the forced cases (e-transfers with no vendor).
    let decision: ReclassClassification["decision"];
    if (confidence >= AUTO_APPROVE_THRESHOLD) decision = "auto_approve";
    else decision = "needs_review";

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
 * Patterns that signal a TRUE peer-to-peer payment — these go to "ask_client".
 *
 * IMPORTANT: Do NOT match "Interac" alone. In Canada, every debit card purchase
 * shows up with "INTERAC PURCHASE - <merchant>" in the descriptor. Matching plain
 * "Interac" would falsely catch every retail transaction and route it to the
 * client-confirmation queue.
 *
 * Real peer payments require explicit terms like "e-Transfer", "EMT", "Venmo",
 * "Zelle", or "Cash App" — these specifically denote person-to-person transfers
 * outside a normal merchant transaction.
 */
const ETRANSFER_PATTERNS = [
  /e[\s\-]?transfer/i,              // e-Transfer, etransfer, e transfer
  /\bemt\b/i,                       // EMT (Email Money Transfer)
  /\be[\s\-]?tfr\b/i,               // e-tfr, etfr, e tfr
  /\bvenmo\b/i,
  /\bzelle\b/i,
  /\bcash\s+app\b/i,                // Cash App (with word boundary on "cash")
  /\bwire\s+transfer\b/i,
  /interac\s+e[\s\-]?transfer/i,    // "Interac e-Transfer" (the peer payment product)
];

// Loan / credit-line activity. These must NEVER be auto-categorized as an
// expense — a loan payment splits into principal (balance-sheet liability) and
// interest, and a draw is a liability increase, so they go to the client/
// bookkeeper to match against the right loan account. Matched against the
// vendor/description/memo AND the account the txn currently sits in (a txn
// already booked to "Loan - Fundbox" / "Short-term business loans" is a loan).
const LOAN_PATTERNS = [
  /\bloan\b/i,
  /\bline of credit\b/i,
  /\bL\.?O\.?C\.?\b/,
  /\bnote[\s\-]?payable\b/i,
  /\bterm loan\b/i,
  /\bfundbox\b|\bondeck\b|\bkabbage\b|\bbluevine\b|\bclearco\b|\bclearbanc\b|\blendified\b|thinking capital|merchant growth|\bforwardly\b|\bdriven\b/i,
  /\bBDC\b/,                          // Business Development Bank of Canada
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
  decision: "auto_approve" | "needs_review" | "flagged" | "ask_client";
  flagged_reason?: string;
}

const FULL_CAT_SYSTEM_PROMPT = `You are the Ironbooks AI Bookkeeper categorizing transactions for a residential painting contractor. Pick the BEST target account for each line and an HONEST, calibrated confidence score. Accuracy matters far more than decisiveness: a wrong category that auto-approves is worse than a correct one sent for a quick human review. When in doubt, score lower and let the bookkeeper confirm.

You'll receive transaction lines (vendor, amount, date, description, current account) and the full list of valid target accounts. For each line, pick the BEST target account and a confidence score.

═══ HOW TO SCORE CONFIDENCE — this drives auto-approve, so be honest ═══
Only 0.95+ auto-approves; everything below goes to a human. Reserve 0.95+ for when the VENDOR IDENTITY makes the account UNAMBIGUOUS — you're not guessing, you KNOW (Sherwin-Williams/Benjamin Moore → Paint & Materials; Esso/Shell/Petro-Canada → Fuel; Rogers/Bell/Telus → Phone/Utilities).

Score BELOW 0.95 (→ human review, NOT auto-approved) whenever you are INFERRING the purpose rather than recognizing the vendor:
- Guessing from the AMOUNT ("small Costco likely food court → Meals", "Costco $128 likely job supplies") → 0.55–0.8.
- A vendor that sells many things, where the purpose is unclear (Costco, Amazon, Walmart, Home Depot → could be Job Supplies, Small Tools, Meals, Office…) → 0.7–0.85.
- Anything where your reasoning would contain "likely", "probably", "could be", "maybe", or a "?" — that BY DEFINITION means <0.95.
- Tax-sensitive items (payroll, taxes, owner draws/distributions, subcontractor labor) when not certain → low.
- A vague descriptor like "spa detailing", "gift baskets", "stationery" where the business purpose is assumed → low; do NOT confidently map to Vehicle/Marketing/etc.
A confident-sounding guess is still a guess. Recognizing the STORE (e.g. "Costco") is not the same as knowing WHAT was bought — that gap is always sub-0.95.

═══ CRITICAL RULES ═══
1. target_account_id MUST be from available_accounts. Never invent.
2. Use vendor + description + amount together — but identifying the merchant ≠ knowing the category.
3. Reasoning ≤12 words, specific to this vendor. If it contains "likely/probably/could be/?", confidence MUST be <0.95.

═══ PAINTER-SPECIFIC VENDOR MAP (identity-certain → use confidence 0.96+) ═══

PAINT SUPPLIERS → Paint & Materials
  Sherwin-Williams, SW Paint, Benjamin Moore, BM, Dunn-Edwards, PPG, Para Paints,
  Cloverdale Paint, General Paint, Behr (when at HD), Kelly-Moore

HARDWARE / JOB SUPPLIES → Job Supplies
  Home Depot, Lowes, Rona, Canadian Tire (job context), Ace Hardware, TSC,
  Princess Auto (job tools), McLendons, Princess Auto

SMALL TOOLS (when explicitly tools, not consumables) → Small Tools
  DeWalt, Milwaukee, Bosch, Makita, Stanley, Klein Tools — if amount suggests tool purchase

FUEL → Fuel – Admin & Sales Vehicles (default) OR Direct Fuel Allocation (if clearly crew)
  Esso, Shell, Chevron, Petro-Canada, Mobil, BP, Husky, Petro-Pass, Speedway, Race Trac,
  Pioneer Gas, Hughes Petroleum, Co-op Gas, Co-op Cardlock, Domo, FasGas, Centex, Mohawk,
  Macewen, Federated Co-op,
  7-Eleven (convenience store — fuel by default unless amount < $15 in which case it might be Meals),
  Costco Gas, Costco Fuel, Costco Cardlock

VEHICLE REPAIRS → Vehicle Repairs – Admin/Sales
  Mr. Lube, Jiffy Lube, Mister Transmission, Canadian Tire Auto, Midas, Kal Tire,
  OK Tire, Fountain Tire, Auto Service, Auto Shop, brake/transmission/tire shops

JOB DISPOSAL → Job Disposal Fees
  Waste Management, WM, Edmonton Waste, City Disposal, BFI, Republic Services,
  GFL Environmental, Bagster, Got Junk, 1-800-GOT-JUNK, dump fees, transfer station

BANK / MERCHANT FEES → Bank Charges
  E-Transfer Fee, E-Tfr Fee, EMT Fee, Interac Fee, Wire Fee, NSF Fee, Bank Service Charge,
  Monthly Plan Fee, Overdraft Fee, Stop Payment Fee, Helcim Fee (when itemized),
  Square Fee, Clover Fee, Stripe Fee (only when explicit — Stripe payouts go elsewhere)

MEALS → Meals (50% deductible)
  Quick-service: Tim Hortons, McDonald's, Subway, Starbucks, A&W, Dairy Queen, Wendy's,
  Burger King, KFC, Popeyes, Taco Bell, Chipotle, Five Guys, Domino's, Pizza Hut, Panera
  Sit-down: Earls, Boston Pizza, Joey's, Cactus Club, Moxie's, Kelsey's, Smitty's, Denny's,
  IHOP, The Keg, Original Joe's, Montana's, State & Main, Browns Socialhouse
  Generic ethnic: Sushi (any), Pho (any), Thai (any), Vietnamese, Chinese, Indian, Mexican
  Costco Food Court, Costco Restaurant (NOT plain "Costco" — those are wholesale)

  RESTAURANT-NAME HEURISTIC (use 0.78 confidence when amount is $5–$80):
  Any vendor name containing one of these tokens with no other clear category match:
    "Bowl", "Grill", "House", "Famous", "Pub", "Cafe", "Bistro", "Diner", "Eatery",
    "Pizzeria", "Sushi", "Pho", "Ramen", "BBQ", "Bar & Grill", "Bowling" + Food,
    possessives like "Ed's", "Mike's", "Joe's", "Mama's" when the amount fits a meal
  Examples that should hit this heuristic:
    "WEM Ed's Bowl" ($25) → Meals (West Edmonton Mall food/bowling)
    "Mike's Famous" ($15) → Meals (sounds like a deli/restaurant)
    "Joe's Pizza" ($30) → Meals
    "Riverside House" ($45) → Meals if no other context

TRAVEL → Travel – Airfare & Lodging
  Air Canada, WestJet, Porter, AC Express, Delta, United, Alaska, Hilton, Marriott,
  Holiday Inn, Best Western, Comfort Inn, Hampton Inn, Sheraton, Hyatt,
  Expedia, Booking.com, Airbnb, Kayak

INSURANCE → General Liability Insurance / Workers Comp – Admin / Health Insurance – Owner
  State Farm, Allstate, Geico, Progressive, Intact, Aviva, Wawanesa, Co-operators,
  TD Insurance, RBC Insurance, Manulife, Sun Life, Blue Cross, WSIB, WCB

ADVERTISING → Online Advertising – Google Ads / Social Media Marketing
  Google Ads, Google LLC (when ads), Meta, Facebook Ads, Instagram, LinkedIn Ads,
  TikTok Ads, Snapchat Ads, Yelp Ads, Angi, HomeAdvisor, Houzz

NETWORKING → Networking Events
  BNI, Chamber of Commerce, Rotary Club, Toastmasters

TRADE SHOWS → Trade Shows / Industry Events
  Anything with "Conference", "Expo", "Trade Show", "Convention" in the name

MARKETING TOOLS / CRM → Marketing Tools
  Jobber, Housecall Pro, ServiceTitan, Markate, Joist, BuilderTrend, CoConstruct,
  Mailchimp, Constant Contact, Hootsuite, Buffer, Canva

SOFTWARE / TECH → Software Subscriptions
  QuickBooks, Intuit, Xero, Wave, FreshBooks, Microsoft, Office 365, Google Workspace,
  Adobe, Dropbox, Slack, Zoom, Notion, Apple iCloud, Zapier, Calendly,
  GoDaddy, Squarespace, Wix, Shopify, Stripe (subscription only), Square POS,
  ChatGPT, OpenAI, Claude, Anthropic, antivirus software
  ⚠ INTUIT/QUICKBOOKS AMOUNT RULE: only SMALL Intuit/QuickBooks charges are software —
  the QBO subscription is ~$50–200 and processing fees are small. Any Intuit/QuickBooks
  charge of $400 OR MORE (esp. memos like "INTUIT NNNN PAYROLL Payroll Deposit") is a
  PAYROLL NET-PAY deposit, NOT software. Never categorize a ≥$400 Intuit charge as
  Software Subscriptions — flag it as payroll (needs_review): if the client runs QBO
  Payroll paycheques it duplicates the gross wages and belongs in Payroll Clearing, not
  an expense account.

TELECOM / UTILITIES → Software Subscriptions (cell/internet) or Utilities (office)
  Rogers, Bell, Telus, Fido, Koodo, Virgin, Freedom Mobile, Verizon, AT&T, T-Mobile, Comcast,
  Spectrum, Shaw, Cogeco
  Office electric/gas/water bills → Utilities

ACCOUNTING / BOOKKEEPING → Accounting & Bookkeeping
  Any name with "CPA", "Accountant", "Bookkeeping", "Tax Service", "H&R Block"

LEGAL → Legal Fees
  Any name with "Law", "Legal", "Attorney", "Lawyer", "Solicitor", "LLP" + lawyer context

OFFICE SUPPLIES → Office Supplies
  Staples, Office Depot, Amazon (small consumables)
  Shoppers Drug Mart, London Drugs, Walgreens, CVS (basic supplies / small purchases)

COMPUTER & TECH EQUIPMENT → Software Subscriptions (if subscription) or Office Supplies (if hardware < $300) or Small Tools (if hardware $300+)
  Best Buy → if < $300: Office Supplies; $300+: Small Tools (treat as capital-ish equipment)
  Apple Store, Microsoft Store → same tier rule

═══ COSTCO DISAMBIGUATION (very common in CA painter books) ═══
Look at the FULL vendor + description string:
  "Costco Gas", "Costco Fuel", "Costco Cardlock"     → Fuel
  "Costco Food Court", "Costco Restaurant"            → Meals
  "Costco Whse", "Costco Wholesale", or plain "Costco" with amount > $50 → Job Supplies (default for trade clients)
  Plain "Costco" with amount < $20                    → Meals (likely food court)
  Plain "Costco" with amount $20–$50                  → 0.7 confidence Job Supplies (could be either)

═══ INTERAC PURCHASE STRIPPING ═══
Many Canadian bank-fed transactions show as "INTERAC PURCHASE - <merchant>" or
"INTERAC RETAIL - <merchant>". The word "INTERAC" is just the payment network —
ignore it and categorize based on the merchant name that follows. Do NOT
interpret "Interac" alone as a peer payment.

═══ SHOPPERS / DRUGSTORE → Job Supplies for trades clients ═══
Painters and tradespeople often buy small consumables (gloves, tape, snacks for
crew, basic hygiene supplies) at Shoppers Drug Mart, London Drugs, Walgreens.
Default: Job Supplies (high confidence) for amounts $5–$100.

OFFICE RENT → Office Rent
  "Rent", "Lease", "Property Management" + recurring monthly amounts → Office Rent

POSTAGE → Postage & Delivery
  Canada Post, USPS, UPS, FedEx, Purolator, DHL

CONTINUING ED → Continuing Education / Professional Development
  Coursera, Udemy, LinkedIn Learning, Skillshare, Pluralsight, any "Training", "Course", "Certification"

PERMIT FEES → Permit Fees
  Anything with "Permit", "City of ___ Permit", "Building Department"

EQUIPMENT RENTAL → Equipment Rental (Job-Specific)
  Sunbelt Rentals, United Rentals, Herc Rentals, ARS, scaffolding rentals, lift rentals

SUBCONTRACTORS → Subcontractors – Painting
  Generally only if explicitly described as subcontractor work or business name suggests trades

═══ AMBIGUOUS / LOW CONFIDENCE ═══
- Amazon: depends on description — if office consumables (medium), if tools (medium), if unknown (LOW)
- Costco/Sam's Club: depends on what was bought — keep medium unless description clarifies
- Walmart/Target: same — depends on items
- Gas station convenience purchases (snacks): if amount < $20 and meals-like → Meals; if $30+ and station name → Fuel
- "Owner", "Draw", "Personal" in vendor name → set target empty, return confidence 0 (it's a draw, not an expense)

═══ NEVER AUTO-APPROVE (LOW CONFIDENCE) ═══
- Payroll providers (Gusto, ADP, Wagepoint, Payworks): confidence 0.3 — these need careful review
- Government / tax authorities (CRA, IRS, State Revenue, etc.): confidence 0.3
- Owner draws, distributions, personal items
- Large round numbers with vague descriptions
- Anything you genuinely can't recognize after using the patterns above

═══ OUTPUT ═══
Return STRICTLY valid JSON:
{
  "decisions": [
    {
      "ref_id": "string (echoes input)",
      "target_account_id": "string (from available_accounts, or empty string)",
      "target_account_name": "string (matches account_name)",
      "confidence": 0.00-1.00,
      "reasoning": "string (≤12 words, vendor-specific)"
    }
  ]
}

No markdown, no preamble. Just the JSON.`;

const FULL_CAT_BATCH_SIZE = 15;
const BATCH_TIMEOUT_MS = 75_000;
// Parallel batches per round. Anthropic Opus tier allows 50+ req/min;
// 6 concurrent keeps us comfortably under rate limits while cutting
// wall-clock by ~6x vs sequential.
// (Lionetti Painting hit a hung Promise.all repeatedly at 3-concurrent —
// one batch never resolved/rejected even with AbortController fired, so
// the function kept ticking until Vercel maxDuration killed it silently,
// 45 min before the DB watchdog cleaned up. Bumping concurrency rolls
// the dice fewer times; the round-level Promise.race cap below catches
// the rest.)
const FULL_CAT_CONCURRENCY = 6;
// Hard wall-clock ceiling per round. Even if Anthropic's SDK fails to
// honor an AbortController (streaming responses sometimes orphan), the
// round resolves at this cap and the loop moves on. Batches that
// didn't return in time become `needs_review` — bookkeeper picks them
// up manually instead of the whole job stranding.
const ROUND_DEADLINE_MS = 90_000;

/**
 * Classify every transaction line against the new COA.
 * Auto-approve rule: a matched target AND confidence >= AUTO_APPROVE_THRESHOLD
 * (0.95). Matched-but-lower-confidence -> needs_review (bookkeeper confirms).
 * E-transfer/Venmo/Zelle without clear vendor → forced to "flagged".
 */
export async function categorizeAllTransactions(params: {
  clientName: string;
  jurisdiction: "US" | "CA";
  stateProvince: string;
  lines: FullCategorizationLine[];
  availableAccounts: AvailableAccount[];
  autoApproveThreshold: number;
  signal?: AbortSignal;
  onProgress?: (doneBatches: number, totalBatches: number) => Promise<void>;
}): Promise<{
  decisions: FullCategorizationDecision[];
  warnings: string[];
  summary: string;
}> {
  const allDecisions: FullCategorizationDecision[] = [];
  const warnings: string[] = [];

  // E-transfer pre-routing.
  //
  //  - Real peer-payment transfers ($5+) → ask_client (each transfer is unique)
  //  - "Fee"-labeled transfers OR very small amounts (<$5) → Bank Charges
  //    (these are bank service charges, not actual peer payments — $1.50 EMT fee,
  //     $1.00 e-transfer fee, etc. are common Canadian charges)
  //  - Plain "Interac Purchase" (NOT "Interac e-Transfer") → falls through to AI
  // Find a Bank Charges account in the client's QBO — be lenient about naming
  const bankChargesAccount = params.availableAccounts.find((a) => {
    const n = a.account_name.toLowerCase();
    return (
      n === "bank charges" ||
      n === "bank charges & fees" ||
      n === "bank charges and fees" ||
      n === "bank service charges" ||
      n === "merchant fees" ||
      n.includes("bank charge") ||
      n.includes("bank fee")
    );
  });

  const linesToClassify: FullCategorizationLine[] = [];
  for (const line of params.lines) {
    const haystack = `${line.vendor_name} ${line.description} ${line.private_note}`;
    const isETransfer = ETRANSFER_PATTERNS.some((re) => re.test(haystack));
    const looksLikeFee = /\bfee\b|service charge/i.test(haystack);
    const absAmount = Math.abs(line.amount);
    const isLikelyFee = isETransfer && (looksLikeFee || absAmount < 5);

    if (isLikelyFee) {
      // Tiny-amount e-transfers / fees → Bank Charges. If the client's QBO doesn't
      // have a matching account yet, still apply the decision — bookkeeper can pick
      // a different account via the dropdown or COA cleanup will add one later.
      allDecisions.push({
        ref_id: line.ref_id,
        target_account_id: bankChargesAccount?.qbo_account_id || null,
        target_account_name: bankChargesAccount?.account_name || "Bank Charges",
        confidence: 0.95,
        reasoning: `${absAmount < 5 ? "Small-amount" : "Fee-labeled"} e-transfer → Bank Charges`,
        decision: "auto_approve",
      });
      continue;
    }

    if (isETransfer) {
      // Real peer payment — ask the client
      allDecisions.push({
        ref_id: line.ref_id,
        target_account_id: null,
        target_account_name: null,
        confidence: 0,
        reasoning: "E-transfer / peer payment — confirm with client what this was for.",
        decision: "ask_client",
        flagged_reason: "Peer payment — needs client confirmation before categorizing",
      });
      continue;
    }

    // Loan / credit-line activity → ask client. A loan payment splits into
    // principal (liability) + interest and must be matched to the right loan
    // account; never auto-book it as an expense.
    const loanHaystack = `${line.vendor_name} ${line.description} ${line.private_note} ${line.current_account_name}`;
    if (LOAN_PATTERNS.some((re) => re.test(loanHaystack))) {
      allDecisions.push({
        ref_id: line.ref_id,
        target_account_id: null,
        target_account_name: null,
        confidence: 0,
        reasoning: "Loan / credit-line payment — match to the right loan account (principal vs interest).",
        decision: "ask_client",
        flagged_reason: "Loan payment — confirm the loan account and principal/interest split",
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

  // Build account lookups for validation (ID-first, name-based fallback)
  const accountById = new Map(params.availableAccounts.map((a) => [a.qbo_account_id, a]));
  const accountByName = new Map(params.availableAccounts.map((a) => [a.account_name.toLowerCase(), a]));

  // Batch through Claude. Batches now run in PARALLEL within a "round" of
  // FULL_CAT_CONCURRENCY (3) — cuts wall-clock time by ~3× so big clients
  // (60+ batches) finish inside Vercel's 800s budget. Each batch still has
  // its own per-call timeout + 529 retry logic; failures inside a batch are
  // contained and don't abort the round.
  const totalBatches = Math.ceil(linesToClassify.length / FULL_CAT_BATCH_SIZE);

  // Per-batch processor — returns its decisions + warnings as locals so the
  // outer aggregator can merge them after each round. Closes over the
  // shared compactAccounts / accountBy* lookups.
  async function processBatch(
    batch: FullCategorizationLine[],
    batchIdx: number
  ): Promise<{ decisions: FullCategorizationDecision[]; warnings: string[] }> {
    const localDecisions: FullCategorizationDecision[] = [];
    const localWarnings: string[] = [];

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

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Anthropic batch timeout after ${BATCH_TIMEOUT_MS}ms`)),
      BATCH_TIMEOUT_MS
    );
    let response: Awaited<ReturnType<typeof client.messages.create>>;
    try {
      response = await withRetry(() =>
        client.messages.create(
          {
            model: MODEL,
            max_tokens: 16000,
            system: FULL_CAT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
          },
          { signal: controller.signal }
        )
      );
    } catch (err: any) {
      localWarnings.push(
        `Batch ${batchIdx}/${totalBatches}: ${err?.message || "request failed"}. Lines fall through to needs_review.`
      );
      return { decisions: localDecisions, warnings: localWarnings };
    } finally {
      clearTimeout(timer);
    }

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      localWarnings.push(`Batch ${batchIdx}/${totalBatches}: no text response from Claude`);
      return { decisions: localDecisions, warnings: localWarnings };
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
      localWarnings.push(`Batch ${batchIdx}/${totalBatches}: JSON parse failed (${err.message})`);
      return { decisions: localDecisions, warnings: localWarnings };
    }

    for (const d of parsed.decisions || []) {
      const sourceLine = batch.find((l) => l.ref_id === d.ref_id);
      if (!sourceLine) continue;

      // Validate target — try ID first, then name-based fallback (Claude sometimes returns
      // the correct name but an invented or misquoted ID).
      const targetAccount =
        (d.target_account_id ? accountById.get(d.target_account_id) : null) ||
        (d.target_account_name ? accountByName.get(d.target_account_name.toLowerCase()) : null) ||
        null;
      const confidence = Math.max(0, Math.min(1, d.confidence));
      const absAmount = Math.abs(sourceLine.amount);

      let decision: "auto_approve" | "needs_review" | "flagged";
      let target_id: string | null = targetAccount?.qbo_account_id || null;
      let target_name: string | null = targetAccount?.account_name || null;

      if (!targetAccount) {
        decision = "flagged";
        target_id = null;
        target_name = null;
      } else if (confidence >= AUTO_APPROVE_THRESHOLD) {
        // ONLY genuinely-confident picks (≥0.95) auto-approve. A medium/low
        // confidence match is a guess, not a decision — it goes to Needs Review
        // so the bookkeeper confirms it. (Previously ANY matched target was
        // auto-approved regardless of confidence, which auto-approved 60-80%
        // guesses like "Costco → Meals, likely food court".)
        decision = "auto_approve";
      } else {
        decision = "needs_review";
      }

      localDecisions.push({
        ref_id: d.ref_id,
        target_account_id: target_id,
        target_account_name: target_name,
        confidence,
        reasoning: d.reasoning || "",
        decision,
        flagged_reason: !targetAccount ? "AI could not confidently pick a target account" : undefined,
      });
    }

    return { decisions: localDecisions, warnings: localWarnings };
  }

  // Build the list of (batch, batchIdx) tuples up front, then run them in
  // rounds of FULL_CAT_CONCURRENCY in parallel.
  const allBatches: Array<{ batch: FullCategorizationLine[]; batchIdx: number }> = [];
  for (let i = 0; i < linesToClassify.length; i += FULL_CAT_BATCH_SIZE) {
    allBatches.push({
      batch: linesToClassify.slice(i, i + FULL_CAT_BATCH_SIZE),
      batchIdx: Math.floor(i / FULL_CAT_BATCH_SIZE) + 1,
    });
  }

  let completedBatches = 0;
  for (let roundStart = 0; roundStart < allBatches.length; roundStart += FULL_CAT_CONCURRENCY) {
    const round = allBatches.slice(roundStart, roundStart + FULL_CAT_CONCURRENCY);

    // Each batch returns { decisions, warnings } even on error (it catches
    // internally). Wrap the WHOLE ROUND in Promise.race against a hard
    // deadline so an orphaned Anthropic stream can't strand the function.
    // Any batch that hasn't resolved by the deadline returns null in the
    // race, and we synthesize needs_review fallbacks for those batches.
    const roundPromise = Promise.all(
      round.map((b) =>
        processBatch(b.batch, b.batchIdx).then(
          (r) => ({ ok: true as const, idx: b.batchIdx, r }),
          (err) => ({ ok: false as const, idx: b.batchIdx, err })
        )
      )
    );
    const deadlinePromise = new Promise<"deadline">((resolve) =>
      setTimeout(() => resolve("deadline"), ROUND_DEADLINE_MS)
    );
    const raceResult = await Promise.race([roundPromise, deadlinePromise]);

    if (raceResult === "deadline") {
      // Round blew the wall clock — likely an Anthropic stream orphaned
      // somewhere. Mark every line in this round's batches as needs_review
      // so the bookkeeper can finish them, and move on. We DON'T wait for
      // the in-flight Promise.all to complete; Node will eventually GC it
      // (and any in-flight HTTP is wasted but harmless).
      for (const b of round) {
        for (const line of b.batch) {
          allDecisions.push({
            ref_id: line.ref_id,
            target_account_id: null,
            target_account_name: null,
            confidence: 0,
            reasoning: `Batch ${b.batchIdx}/${totalBatches} exceeded ${ROUND_DEADLINE_MS / 1000}s — likely AI stream stalled. Manually categorize.`,
            decision: "needs_review",
            flagged_reason: "AI batch timed out",
          });
        }
        warnings.push(
          `Round containing batch ${b.batchIdx}/${totalBatches} exceeded ${ROUND_DEADLINE_MS / 1000}s deadline — lines marked needs_review.`
        );
      }
    } else {
      for (const r of raceResult) {
        if (r.ok) {
          allDecisions.push(...r.r.decisions);
          warnings.push(...r.r.warnings);
        } else {
          // processBatch normally catches its own errors; this is the
          // belt-and-braces path for the rare uncaught throw.
          warnings.push(
            `Batch ${r.idx}/${totalBatches} threw: ${(r.err as any)?.message || r.err}. Lines fall through to needs_review.`
          );
          const failedBatch = round.find((b) => b.batchIdx === r.idx);
          if (failedBatch) {
            for (const line of failedBatch.batch) {
              allDecisions.push({
                ref_id: line.ref_id,
                target_account_id: null,
                target_account_name: null,
                confidence: 0,
                reasoning: `Batch ${r.idx} failed — manually categorize.`,
                decision: "needs_review",
                flagged_reason: "AI batch threw",
              });
            }
          }
        }
      }
    }
    completedBatches += round.length;
    if (params.onProgress) {
      await params.onProgress(completedBatches, totalBatches).catch(() => {});
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

// ════════════════════════════════════════════════════════════════════════════
// WEB SEARCH FALLBACK — for unknown vendors
// ════════════════════════════════════════════════════════════════════════════

/**
 * Given a vendor name + optional client city, use Claude's web search tool to
 * identify what type of business it is, then map to a master COA account.
 *
 * Used as a 4th-tier fallback in the pipeline:
 *   1. Knowledge base (instant)        →  ~200 known patterns
 *   2. Per-client bank rules (instant) →  learned from prior runs
 *   3. Batched Claude (single call)    →  general categorization
 *   4. Web search (this function)      →  for vendors Claude returned low-confidence on
 *
 * Each call is one Claude API request (with web_search tool enabled), so this
 * is the slowest path. Only used when needed.
 */
export async function webSearchVendor(params: {
  vendorName: string;
  clientCity?: string;
  availableAccounts: AvailableAccount[];
}, opts?: { signal?: AbortSignal }): Promise<{
  target_account_id: string | null;
  target_account_name: string | null;
  confidence: number;
  reasoning: string;
} | null> {
  if (!params.vendorName || params.vendorName.toLowerCase() === "unknown vendor") {
    return null;
  }

  const accountsList = params.availableAccounts
    .map((a) => `- ${a.account_name}`)
    .join("\n");

  const query = params.clientCity
    ? `"${params.vendorName}" ${params.clientCity} what type of business`
    : `"${params.vendorName}" what type of business`;

  const userMessage = `I need to categorize a vendor for a small bookkeeping system.

Vendor: "${params.vendorName}"
${params.clientCity ? `Client is located in: ${params.clientCity}` : ""}

Please search the web to figure out what type of business this vendor is, then map it to one of these accounts:

${accountsList}

Return STRICTLY valid JSON, no other text:
{
  "target_account_name": "string (must match one of the listed accounts exactly, or empty string if no match)",
  "confidence": 0.00-1.00,
  "reasoning": "short sentence — what is this vendor and why this account"
}`;

  // Hard per-vendor timeout. AbortController actually cancels the underlying
  // HTTP request — unlike Promise.race+setTimeout which leaves ghost connections
  // accumulating across batches and starving the worker.
  // 25s covers the 95th-percentile call (typical: 5–15s). The outer
  // WEB_SEARCH_BUDGET_MS in the discover route is a second safety net.
  const WEB_SEARCH_TIMEOUT_MS = 25_000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`web_search timeout after ${WEB_SEARCH_TIMEOUT_MS}ms`)),
      WEB_SEARCH_TIMEOUT_MS
    );
    // Forward external abort (e.g. skip signal) into our controller
    if (opts?.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        throw opts.signal.reason || new Error("Aborted");
      }
      opts.signal.addEventListener("abort", () => {
        controller.abort(opts!.signal!.reason || new Error("Aborted externally"));
      }, { once: true });
    }
    let response: Awaited<ReturnType<typeof client.messages.create>>;
    try {
      response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 1500,
          tools: [
            {
              type: "web_search_20250305" as any,
              name: "web_search",
              max_uses: 2,
            } as any,
          ],
          messages: [{ role: "user", content: userMessage }],
        },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }

    // The final text block is the JSON result (after any tool use)
    const textBlocks = response.content.filter((c: any) => c.type === "text");
    const lastText = textBlocks[textBlocks.length - 1];
    if (!lastText || lastText.type !== "text") return null;

    const raw = lastText.text
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = JSON.parse(raw) as {
      target_account_name: string;
      confidence: number;
      reasoning: string;
    };

    if (!parsed.target_account_name) return null;

    // Find the account in available accounts
    const account = params.availableAccounts.find(
      (a) => a.account_name.toLowerCase() === parsed.target_account_name.toLowerCase()
    );
    if (!account) return null;

    return {
      target_account_id: account.qbo_account_id,
      target_account_name: account.account_name,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      reasoning: `(web search) ${parsed.reasoning}`,
    };
  } catch (err: any) {
    console.warn(`[webSearchVendor] Failed for "${params.vendorName}":`, err.message);
    return null;
  }
}
