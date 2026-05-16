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
import { lookupVendor, normalizeVendorForLookup } from "./vendor-knowledge";

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

const FULL_CAT_SYSTEM_PROMPT = `You are the IronBooks AI Bookkeeper categorizing transactions for a residential painting contractor. Your job is to be DECISIVE — most transactions have an obvious home; you should auto-approve them at high confidence. Flagging should be rare.

You'll receive transaction lines (vendor, amount, date, description, current account) and the full list of valid target accounts. For each line, pick the BEST target account and a confidence score.

═══ DECISIVENESS — BE AGGRESSIVE ═══
The previous version of this prompt was way too conservative. Junior bookkeepers were getting 277 flagged out of 339 transactions. That's unacceptable. You should aim for 80%+ auto-approve.

When a vendor matches a well-known business pattern, you have HIGH confidence (0.92+). Don't second-guess yourself on Esso, Home Depot, Sherwin-Williams, etc. These are unambiguous.

═══ CRITICAL RULES ═══
1. target_account_id MUST be from available_accounts. Never invent.
2. Confidence 0.92+ for known vendor patterns (gas stations, paint suppliers, telcos, etc.).
3. Confidence 0.75-0.91 for plausible but slightly ambiguous (Home Depot could be Job Supplies OR Small Tools).
4. Confidence <0.75 means real ambiguity — return your best guess but acknowledge it.
5. Use vendor + description + amount together. A $5 charge from Esso is fuel; a $5000 charge is not.
6. Reasoning is short (≤12 words), specific to this vendor.

═══ PAINTER-SPECIFIC VENDOR MAP (use confidence 0.92+) ═══

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

  // E-transfer pre-routing.
  //
  //  - Real peer-payment transfers ($5+) → ask_client (each transfer is unique)
  //  - "Fee"-labeled transfers OR very small amounts (<$5) → Bank Charges
  //    (these are bank service charges, not actual peer payments — $1.50 EMT fee,
  //     $1.00 e-transfer fee, etc. are common Canadian charges)
  //  - Plain "Interac Purchase" (NOT "Interac e-Transfer") → falls through to AI
  const bankChargesAccount = params.availableAccounts.find(
    (a) =>
      a.account_name.toLowerCase() === "bank charges" ||
      a.account_name.toLowerCase() === "bank charges & fees" ||
      a.account_name.toLowerCase() === "bank charges and fees"
  );

  const linesToClassify: FullCategorizationLine[] = [];
  for (const line of params.lines) {
    const haystack = `${line.vendor_name} ${line.description} ${line.private_note}`;
    const isETransfer = ETRANSFER_PATTERNS.some((re) => re.test(haystack));
    const looksLikeFee = /\bfee\b|service charge/i.test(haystack);
    const absAmount = Math.abs(line.amount);
    const isLikelyFee = isETransfer && (looksLikeFee || absAmount < 5);

    if (isLikelyFee && bankChargesAccount) {
      // Tiny-amount e-transfers / fees → Bank Charges
      allDecisions.push({
        ref_id: line.ref_id,
        target_account_id: bankChargesAccount.qbo_account_id,
        target_account_name: bankChargesAccount.account_name,
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
}): Promise<{
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

  try {
    const response = await client.messages.create({
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
    });

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
