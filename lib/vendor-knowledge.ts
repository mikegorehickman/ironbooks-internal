/**
 * Vendor Knowledge Base
 * ─────────────────────
 * Pre-Claude lookup table for the ~200 most common vendors a Canadian trades
 * contractor encounters. Saves an API call per transaction match — orders of
 * magnitude faster than asking Claude, and zero cost.
 *
 * Lookup order in the reclass pipeline:
 *   1. This knowledge base (instant, no API call)
 *   2. Per-client bank_rules cache (instant DB query)
 *   3. Claude AI (batched API call)
 *   4. Web search (Claude tool use, only for low-confidence items)
 *
 * Account names returned here MUST match the master COA. Industry-specific
 * accounts (like "Job Supplies & Materials") are tagged with `industries` so they
 * only fire for matching industries.
 */

export interface VendorMatch {
  /** Master COA account name (must match an account in master_coa table) */
  account: string;
  /** 0-1 confidence */
  confidence: number;
  /** Why we matched (short, vendor-specific) */
  reasoning: string;
  /** Canonical payee display name — set as the QBO vendor on push when the
   *  transaction has none (bank-fed lines often carry no payee even though
   *  the description identifies the vendor). */
  vendor?: string;
}

interface VendorPattern {
  /** Regex to match against the vendor name + description */
  pattern: RegExp;
  account: string;
  confidence: number;
  reasoning: string;
  /** If set, only matches when current client is in one of these industries */
  industries?: string[];
  /** If set, only matches when the transaction amount is in this range */
  amountRange?: [number, number];
  /** Canonical payee display name (see VendorMatch.vendor) */
  vendor?: string;
}

// ─────────── Patterns ───────────
// Order matters: more specific patterns first. First match wins.

const PATTERNS: VendorPattern[] = [
  // ══════ GAS-STATION SNACK OVERLAY — MUST STAY FIRST ══════
  // First-match-wins: this must precede every individual gas-brand rule or
  // the brand rules capture the small purchases as Fuel (the QuikTrip bug).
  // The <$20 amountRange means fills fall through to the brand rules below.
  // ALL retail gas brands (Mike 2026-07-13: "<$20 at any gas station → Meals").
  // Deliberately still excludes pay-at-pump-only / commercial cardlock vendors
  // (Costco Gas, Petro-Pass, Hughes, Co-op Cardlock, Federated Co-op, WEX
  // fleet cards) where a small amount is still fuel.
  { pattern: /\bessom?\b|\bshell\b(?!.*lube)|\bchevron\b|petro[\s\-]?canada|\bhusky\b|\bdomo\b|\bfasgas\b|\bcentex\b|\bcenex\b|\bmohawk\b|\bpioneer\b|\b7[\s\-]?eleven\b|\bcircle\s*k\b|\brace\s*trac\b|\bspeedway\b|\bsunoco\b|\b(mobil|exxon)\b|\bquiktrip\b|quick\s+trip\b|kwik\s+trip|\bwawa\b|\bcasey'?s?\b|\bsheetz\b|\bmarathon\b|\bmacewen\b|\bbp\s+(gas|fuel)/i, account: "Meals (50% deductible)", confidence: 0.90, reasoning: "Small gas-station purchase (<$20) → likely snack/coffee, not fuel", amountRange: [0, 19.99] },
  { pattern: /child\s*support|family\s*support|alimony|maintenance\s+enforcement|fmep\b|\bmep\b/i, account: "Owner's Draw", confidence: 0.9, reasoning: "Owner's Draw (keyword match)" },
  { pattern: /\bvistaprint\b/i, account: "Online Advertising - Ad Spend", confidence: 0.9, reasoning: "Vistaprint → Online Advertising - Ad Spend", vendor: "Vistaprint" },
  { pattern: /\bindeed\b/i, account: "Recruiting", confidence: 0.9, reasoning: "Indeed → Recruiting", vendor: "Indeed" },
  { pattern: /painter\s+growth\s+venture|painter\s+growth/i, account: "Continuing Education / Professional Development", confidence: 0.9, reasoning: "Painter Growth → Continuing Education / Professional Development", vendor: "Painter Growth" },
  { pattern: /\bdripjobs\b|drip\s+jobs/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Dripjobs → Software Subscriptions", vendor: "Dripjobs" },
  { pattern: /ironbooks\s+financial/i, account: "Accounting & Bookkeeping", confidence: 0.9, reasoning: "Ironbooks Financial → Accounting & Bookkeeping", vendor: "Ironbooks Financial" },
  { pattern: /\btarget\b/i, account: "Office Supplies", confidence: 0.9, reasoning: "Target → Office Supplies", vendor: "Target" },
  { pattern: /\bcanva\b/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Canva → Software Subscriptions", vendor: "Canva" },
  { pattern: /\bverizon\b/i, account: "Utilities", confidence: 0.9, reasoning: "Verizon → Utilities", vendor: "Verizon" },
  { pattern: /at\&t/i, account: "Utilities", confidence: 0.9, reasoning: "AT&T → Utilities", vendor: "AT&T" },
  { pattern: /\bzapier\b/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Zapier → Software Subscriptions", vendor: "Zapier" },
  { pattern: /harbor\s+freight\s+tools/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "Harbor Freight Tools → Job Supplies & Materials", vendor: "Harbor Freight Tools" },
  { pattern: /\bcasey\b/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Casey's → Fuel – Overhead", vendor: "Casey's" },
  { pattern: /\bgusto\b/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "Payroll Expenses (keyword match)" },
  { pattern: /chick\s+fil/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Chick Fil A → Meals (50% deductible)", vendor: "Chick Fil A" },
  { pattern: /best\s+buy/i, account: "Office Supplies", confidence: 0.9, reasoning: "Best Buy → Office Supplies", vendor: "Best Buy" },
  { pattern: /\bdollarama\b/i, account: "Office Supplies", confidence: 0.9, reasoning: "Dollarama → Office Supplies", vendor: "Dollarama" },
  { pattern: /better\s+business\s+bureau/i, account: "Marketing Tools", confidence: 0.9, reasoning: "Better Business Bureau → Marketing Tools", vendor: "Better Business Bureau" },
  { pattern: /\bmenards\b|\bmenard\b/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "Menards → Job Supplies & Materials", vendor: "Menards" },
  { pattern: /dunkin\s+donuts/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Dunkin Donuts → Meals (50% deductible)", vendor: "Dunkin Donuts" },
  { pattern: /\bmailchimp\b/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Mailchimp → Software Subscriptions", vendor: "Mailchimp" },
  { pattern: /\bmarathon\b/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Marathon → Fuel – Overhead", vendor: "Marathon" },
  { pattern: /\bthumbtack\b|thumbtack\s+marke/i, account: "Online Advertising - Ad Spend", confidence: 0.9, reasoning: "Thumbtack → Online Advertising - Ad Spend", vendor: "Thumbtack" },
  { pattern: /\bspectrum\b/i, account: "Utilities", confidence: 0.9, reasoning: "Spectrum → Utilities", vendor: "Spectrum" },
  { pattern: /\bwawa\b/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Wawa → Fuel – Overhead", vendor: "Wawa" },
  { pattern: /dulux\s+paints|\bdulux\b/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "Dulux Paints → Job Supplies & Materials", vendor: "Dulux Paints" },
  { pattern: /kwik\s+trip/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Kwik Trip → Fuel – Overhead", vendor: "Kwik Trip" },
  // A LARGE Intuit/QuickBooks charge (≥$400) is a payroll NET-PAY deposit, NOT
  // software — the QBO subscription (~$50–200) and QB Payments processing fees
  // are small. Confirmed on BMD (Mike 2026-07-17): "INTUIT NNNN PAYROLL Payroll
  // Deposit" lines were dumped in Software Subscriptions. Flag it (low conf →
  // needs review) and point at Payroll Clearing: if the client runs QBO Payroll
  // paycheques, these net-pay deposits duplicate the gross wages and belong OFF
  // the P&L. MUST sit before the payroll-fee + Software Intuit rules so it wins
  // for big amounts; small Intuit charges fall through to those.
  { pattern: /\b(intuit|quickbooks|qbooks)\b/i, account: "Payroll Clearing", confidence: 0.7, reasoning: "Large Intuit/QuickBooks charge (≥$400) is payroll net-pay, NOT software. If QBO Payroll paycheques exist this duplicates the gross wages — move to Payroll Clearing (payroll double-count tool), don't leave it as an expense. (Verify it isn't a rare large merchant-processing fee.)", vendor: "Intuit Payroll", amountRange: [400, 100000000] },
  { pattern: /(intuit|qb|quickbooks).{0,12}payroll|payroll.{0,8}intuit/i, account: "Payroll Expenses", confidence: 0.93, reasoning: "Intuit/QuickBooks Payroll service fee → Payroll Expenses", vendor: "Intuit Payroll" },
  { pattern: /uber\s+eats/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Uber Eats → Meals (50% deductible)", vendor: "Uber Eats" },
  { pattern: /stop\s+shop/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Stop & Shop → Meals (50% deductible)", vendor: "Stop & Shop" },
  { pattern: /\bpaychex\b|paychex\s+taxes|paychex\s+flexperks/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "Payroll Expenses (keyword match)" },
  { pattern: /\bhartford\b/i, account: "Insurance – Other", confidence: 0.9, reasoning: "The Hartford → Insurance – Other", vendor: "The Hartford" },
  { pattern: /\bsafeway\b|\bsafeway\b/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Safeway → Meals (50% deductible)", vendor: "Safeway" },
  { pattern: /paint\s+scout/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Software Subscriptions (keyword match)" },
  { pattern: /\btelus\b/i, account: "Utilities", confidence: 0.9, reasoning: "Telus → Utilities", vendor: "Telus" },
  { pattern: /\bnetflix\b/i, account: "Owner's Draw", confidence: 0.9, reasoning: "Netflix → Owner's Draw", vendor: "Netflix" },
  { pattern: /\bpioneer\b|pioneer\s+(gas|station)/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Pioneer → Fuel – Overhead", vendor: "Pioneer" },
  { pattern: /prime\s+video/i, account: "Owner's Draw", confidence: 0.9, reasoning: "Prime Video → Owner's Draw", vendor: "Prime Video" },
  { pattern: /next\s+insurance/i, account: "CGL Insurance", confidence: 0.9, reasoning: "Next Insurance → CGL Insurance", vendor: "Next Insurance" },
  { pattern: /\bquiktrip\b|quick\s+trip/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Quiktrip → Fuel – Overhead", vendor: "Quiktrip" },
  { pattern: /cox\s+communications/i, account: "Utilities", confidence: 0.9, reasoning: "Cox Communications → Utilities", vendor: "Cox Communications" },
  { pattern: /\badp\b|adp\s+payroll|adp\s+payroll\s+fees/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "Payroll Expenses (keyword match)" },
  { pattern: /\brogers\b/i, account: "Utilities", confidence: 0.9, reasoning: "Rogers → Utilities", vendor: "Rogers" },
  { pattern: /\bfanbasis\b|fanbasis\s+com/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Fanbasis → Software Subscriptions", vendor: "Fanbasis" },
  { pattern: /ez\s+pass/i, account: "Tolls", confidence: 0.9, reasoning: "EZ Pass → Tolls", vendor: "EZ Pass" },
  { pattern: /playstation\s+network/i, account: "Owner's Draw", confidence: 0.9, reasoning: "PlayStation Network → Owner's Draw", vendor: "PlayStation Network" },
  { pattern: /combined\s+insurance/i, account: "Insurance – Other", confidence: 0.9, reasoning: "Combined Insurance → Insurance – Other", vendor: "Combined Insurance" },
  { pattern: /\bsheetz\b/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Sheetz → Fuel – Overhead", vendor: "Sheetz" },
  { pattern: /bell\s+mobility/i, account: "Utilities", confidence: 0.9, reasoning: "Bell Mobility → Utilities", vendor: "Bell Mobility" },
  { pattern: /housecall\s+pro/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Housecall Pro → Software Subscriptions", vendor: "Housecall Pro" },
  { pattern: /save\s+on\s+foods|save[\s\-]?on[\s\-]?foods/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Save-On-Foods → Meals (50% deductible)", vendor: "Save-On-Foods" },
  { pattern: /sherwin|sherwin[\s\-]?williams|^sw\s+(paint|stores)/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "Sherwin Williams → Job Supplies & Materials", vendor: "Sherwin Williams", industries: ["painters"] },
  { pattern: /\bpublick\b/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "The Publick → Meals (50% deductible)", vendor: "The Publick" },
  { pattern: /paint\s+depot/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "Paint Depot → Job Supplies & Materials", vendor: "Paint Depot" },
  { pattern: /five\s+star\s+painting/i, account: "Subcontractors", confidence: 0.9, reasoning: "Five Star Painting → Subcontractors", vendor: "Five Star Painting" },
  { pattern: /t[\s\-]?mobile/i, account: "Utilities", confidence: 0.9, reasoning: "T-Mobile → Utilities", vendor: "T-Mobile" },
  { pattern: /hughes\s+petroleu|hughes\s+petroleum/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Hughes Petroleum → Fuel – Overhead", vendor: "Hughes Petroleum" },
  { pattern: /floor\s+decor/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "Floor Decor → Job Supplies & Materials", vendor: "Floor Decor" },
  { pattern: /\bquicken\b/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "Quicken → Software Subscriptions", vendor: "Quicken" },
  { pattern: /freshco|\bfresh[\s\-]?co\b/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "FreshCo → Meals (50% deductible)", vendor: "FreshCo" },
  { pattern: /\bpaycor\b/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "Payroll Expenses (keyword match)" },
  { pattern: /\bpaylocity\b/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "Payroll Expenses (keyword match)" },
  { pattern: /beans\s+cafe/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Beans Cafe → Meals (50% deductible)", vendor: "Beans Cafe" },
  { pattern: /washington\s+township\s+small/i, account: "Licenses", confidence: 0.9, reasoning: "Washington Township Small → Licenses", vendor: "Washington Township Small" },
  { pattern: /eversource\s+web\s+pay/i, account: "Utilities", confidence: 0.9, reasoning: "Eversource Web Pay → Utilities", vendor: "Eversource Web Pay" },
  { pattern: /\brepcolite\b/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "Repcolite → Job Supplies & Materials", vendor: "Repcolite" },
  { pattern: /wex\s+inc\s+fleet/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "Wex Fleet → Fuel – Overhead", vendor: "Wex Fleet" },
  { pattern: /national\s+grid/i, account: "Utilities", confidence: 0.9, reasoning: "National Grid → Utilities", vendor: "National Grid" },
  { pattern: /\bclickgrow\b/i, account: "Online Advertising - Ad Spend", confidence: 0.9, reasoning: "ClickGrow → Online Advertising - Ad Spend", vendor: "ClickGrow" },
  { pattern: /southern\s+oak\s+gift/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "Meals (50% deductible) (keyword match)" },
  { pattern: /amazon\s+business/i, account: "Office Supplies", confidence: 0.9, reasoning: "Amazon Business → Office Supplies", vendor: "Amazon Business" },
  { pattern: /sgi\s+canada\s+saskatchewan/i, account: "Vehicle Insurance", confidence: 0.9, reasoning: "SGI Canada → Vehicle Insurance", vendor: "SGI Canada" },
  { pattern: /\batm\s+(withdrawal|wd|w\/d|cash|debit)/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Owner's Draw (keyword match)" },
  { pattern: /\bwithdrawal\s*[\-:]\s*atm/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Owner's Draw (keyword match)" },
  { pattern: /^atm\b/i, account: "Owner's Draw", confidence: 0.88, reasoning: "Owner's Draw (keyword match)" },
  // ══════════════════ BANK CHARGES / E-TRANSFER FEES ══════════════════
  // Tiny amounts with e-transfer wording are always the ~$1.50 fee.
  { pattern: /e[\s\-]?transfer/i, account: "Bank Charges", confidence: 0.99, reasoning: "e-Transfer < $2 → Bank Charges (fee)", amountRange: [0, 2] },
  { pattern: /\be[\s\-]?tfr\b/i, account: "Bank Charges", confidence: 0.99, reasoning: "e-Tfr < $2 → Bank Charges (fee)", amountRange: [0, 2] },
  { pattern: /\bemt\b/i, account: "Bank Charges", confidence: 0.99, reasoning: "EMT < $2 → Bank Charges (fee)", amountRange: [0, 2] },
  { pattern: /\b(fee|service\s+charge|nsf|overdraft)\b/i, account: "Bank Charges", confidence: 0.97, reasoning: "Small fee/service charge → Bank Charges", amountRange: [0, 5] },
  // Explicit "…fee" descriptors are a fee at ANY amount (no amountRange).
  { pattern: /\bnsf\s+fee|nsf\s+charge/i, account: "Bank Charges", confidence: 0.99, reasoning: "NSF Fee → Bank Charges" },
  { pattern: /overdraft\s+fee/i, account: "Bank Charges", confidence: 0.99, reasoning: "Overdraft Fee → Bank Charges" },
  { pattern: /bank\s+service\s+charge|monthly\s+plan\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Bank Service Charge → Bank Charges" },
  { pattern: /stop\s+payment\s+fee|wire\s+fee|wire\s+transfer\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Wire/Stop-payment fee → Bank Charges" },
  { pattern: /interac\s+e[\s\-]?transfer\s+fee|e[\s\-]?tfr\s+fee|emt\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Interac e-Transfer Fee → Bank Charges" },
  { pattern: /\bfit4less\b/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Fit4Less → Owner's Draw", vendor: "Fit4Less" },
  { pattern: /good\s*life\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "GoodLife Fitness → Owner's Draw", vendor: "GoodLife Fitness" },
  { pattern: /anytime\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Anytime Fitness → Owner's Draw", vendor: "Anytime Fitness" },
  { pattern: /\bplanet\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Planet Fitness → Owner's Draw", vendor: "Planet Fitness" },
  { pattern: /\bworld\s+gym\b/i, account: "Owner's Draw", confidence: 0.95, reasoning: "World Gym → Owner's Draw", vendor: "World Gym" },
  { pattern: /\bcrunch\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Crunch Fitness → Owner's Draw", vendor: "Crunch Fitness" },
  { pattern: /\bla\s+fitness\b/i, account: "Owner's Draw", confidence: 0.95, reasoning: "LA Fitness → Owner's Draw", vendor: "LA Fitness" },
  { pattern: /24\s*hour\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "24 Hour Fitness → Owner's Draw", vendor: "24 Hour Fitness" },
  { pattern: /\borange\s*theory/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Orangetheory → Owner's Draw", vendor: "Orangetheory" },
  { pattern: /\bcurves\b/i, account: "Owner's Draw", confidence: 0.93, reasoning: "Curves → Owner's Draw", vendor: "Curves" },
  { pattern: /\bf45\b/i, account: "Owner's Draw", confidence: 0.93, reasoning: "F45 → Owner's Draw", vendor: "F45" },
  { pattern: /\bcrossfit\b/i, account: "Owner's Draw", confidence: 0.93, reasoning: "CrossFit → Owner's Draw", vendor: "CrossFit" },
  { pattern: /\byoga\s+(studio|barn|works)/i, account: "Owner's Draw", confidence: 0.90, reasoning: "Owner's Draw (keyword match)" },
  { pattern: /\bsobeys\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Sobeys → Meals (50% deductible)", vendor: "Sobeys" },
  { pattern: /\bloblaws?\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Loblaws → Meals (50% deductible)", vendor: "Loblaws" },
  { pattern: /real\s+canadian\s+superstore|\bsuperstore\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Real Canadian Superstore → Meals (50% deductible)", vendor: "Real Canadian Superstore" },
  { pattern: /\biga\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "IGA → Meals (50% deductible)", vendor: "IGA" },
  { pattern: /\bco[\s\-]?op\s+food/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Co-op Food → Meals (50% deductible)", vendor: "Co-op Food" },
  { pattern: /\bno\s+frills\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "No Frills → Meals (50% deductible)", vendor: "No Frills" },
  { pattern: /\bmetro\b\s*(grocer|food)?/i, account: "Meals (50% deductible)", confidence: 0.85, reasoning: "Metro → Meals (50% deductible)", vendor: "Metro" },
  { pattern: /\bt\s*&\s*t\s+supermarket|t\&t\s+market/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "T&T Supermarket → Meals (50% deductible)", vendor: "T&T Supermarket" },
  { pattern: /\bfortinos\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Fortinos → Meals (50% deductible)", vendor: "Fortinos" },
  { pattern: /\bzehrs\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Zehrs → Meals (50% deductible)", vendor: "Zehrs" },
  { pattern: /\bvalu[\s\-]?mart\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Valu-mart → Meals (50% deductible)", vendor: "Valu-mart" },
  { pattern: /\bwalmart\b|\bwal[\s\-]?mart\b/i, account: "Office Supplies", confidence: 0.92, reasoning: "Walmart → Office Supplies", vendor: "Walmart" },
  { pattern: /costco\s*(gas|fuel|cardlock)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Costco Gas → Fuel – Overhead", vendor: "Costco Gas" },
  { pattern: /costco\s*(food court|restaurant)/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Meals (50% deductible) (keyword match)" },
  { pattern: /costco\s*(whse|wholesale|business)/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Costco Wholesale → Job Supplies & Materials", vendor: "Costco Wholesale" },
  // Gas-station small purchases (≤$15) → snack/coffee, not fuel. MUST precede the fuel block.
  { pattern: /\bessom?\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Esso → Fuel – Overhead", vendor: "Esso" },
  { pattern: /\bshell\b(?!.*lube)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Shell → Fuel – Overhead", vendor: "Shell" },
  { pattern: /\bchevron\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Chevron → Fuel – Overhead", vendor: "Chevron" },
  { pattern: /petro[\s\-]?canada/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Petro-Canada → Fuel – Overhead", vendor: "Petro-Canada" },
  { pattern: /\bpetro[\s\-]?pass\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Petro-Pass → Fuel – Overhead", vendor: "Petro-Pass" },
  { pattern: /\bhusky\b(?!.*travel)|\bhusky\s+travel/i, account: "Fuel – Overhead", confidence: 0.93, reasoning: "Husky → Fuel – Overhead", vendor: "Husky" },
  { pattern: /\bco[\s\-]?op\s+(gas|cardlock|fuel)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Fuel – Overhead (keyword match)" },
  { pattern: /federated\s+co[\s\-]?op/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Federated Co-op → Fuel – Overhead", vendor: "Federated Co-op" },
  { pattern: /\bdomo\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Domo → Fuel – Overhead", vendor: "Domo" },
  { pattern: /\bfasgas\b/i, account: "Fuel – Overhead", confidence: 0.93, reasoning: "FasGas → Fuel – Overhead", vendor: "FasGas" },
  { pattern: /\bcentex\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Centex → Fuel – Overhead", vendor: "Centex" },
  { pattern: /\bmohawk\b/i, account: "Fuel – Overhead", confidence: 0.88, reasoning: "Mohawk → Fuel – Overhead", vendor: "Mohawk" },
  { pattern: /\bmacewen\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Macewen → Fuel – Overhead", vendor: "Macewen" },
  { pattern: /\b7[\s\-]?eleven\b/i, account: "Fuel – Overhead", confidence: 0.85, reasoning: "7-Eleven → Fuel – Overhead", vendor: "7-Eleven" },
  { pattern: /\bcircle\s*k\b/i, account: "Fuel – Overhead", confidence: 0.85, reasoning: "Circle K → Fuel – Overhead", vendor: "Circle K" },
  { pattern: /\brace\s*trac\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Race Trac → Fuel – Overhead", vendor: "Race Trac" },
  { pattern: /\bspeedway\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Speedway → Fuel – Overhead", vendor: "Speedway" },
  { pattern: /\bsunoco\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Sunoco → Fuel – Overhead", vendor: "Sunoco" },
  { pattern: /\bmobil\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Mobil → Fuel – Overhead", vendor: "Mobil" },
  { pattern: /\bexxon\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Exxon → Fuel – Overhead", vendor: "Exxon" },
  { pattern: /\bbp\s+(gas|fuel)/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "BP → Fuel – Overhead", vendor: "BP" },
  { pattern: /benjamin\s+moore|\bbm\s+paint/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Benjamin Moore → Job Supplies & Materials", vendor: "Benjamin Moore", industries: ["painters"] },
  { pattern: /dunn[\s\-]?edwards/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Dunn-Edwards → Job Supplies & Materials", vendor: "Dunn-Edwards", industries: ["painters"] },
  { pattern: /\bppg\b/i, account: "Job Supplies & Materials", confidence: 0.92, reasoning: "PPG → Job Supplies & Materials", vendor: "PPG", industries: ["painters"] },
  { pattern: /para\s+paint/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Para Paints → Job Supplies & Materials", vendor: "Para Paints", industries: ["painters"] },
  { pattern: /cloverdale\s+paint/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Cloverdale Paint → Job Supplies & Materials", vendor: "Cloverdale Paint", industries: ["painters"] },
  { pattern: /general\s+paint/i, account: "Job Supplies & Materials", confidence: 0.92, reasoning: "General Paint → Job Supplies & Materials", vendor: "General Paint", industries: ["painters"] },
  { pattern: /kelly[\s\-]?moore/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Kelly-Moore → Job Supplies & Materials", vendor: "Kelly-Moore", industries: ["painters"] },
  { pattern: /\bbehr\b/i, account: "Job Supplies & Materials", confidence: 0.90, reasoning: "Behr Paint → Job Supplies & Materials", vendor: "Behr Paint", industries: ["painters"] },
  { pattern: /home\s+depot|\bhd\s+supply/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Home Depot → Job Supplies & Materials", vendor: "Home Depot" },
  { pattern: /\blowes\b|\blowe['']?s\b/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Lowe's → Job Supplies & Materials", vendor: "Lowe's" },
  { pattern: /\brona\b/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Rona → Job Supplies & Materials", vendor: "Rona" },
  { pattern: /canadian\s+tire|canadian\s+tire\s+(auto|car)/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Canadian Tire → Job Supplies & Materials", vendor: "Canadian Tire" },
  { pattern: /\bace\s+hardware/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Ace Hardware → Job Supplies & Materials", vendor: "Ace Hardware" },
  { pattern: /princess\s+auto/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Princess Auto → Job Supplies & Materials", vendor: "Princess Auto" },
  { pattern: /\btsc\s+stores/i, account: "Job Supplies & Materials", confidence: 0.90, reasoning: "TSC Stores → Job Supplies & Materials", vendor: "TSC Stores" },
  { pattern: /tractor\s+supply/i, account: "Job Supplies & Materials", confidence: 0.90, reasoning: "Tractor Supply → Job Supplies & Materials", vendor: "Tractor Supply" },
  { pattern: /shoppers\s+drug\s+mart|\bsdm\b/i, account: "Office Supplies", confidence: 0.85, reasoning: "Shoppers Drug Mart → Office Supplies", vendor: "Shoppers Drug Mart" },
  { pattern: /london\s+drugs/i, account: "Office Supplies", confidence: 0.85, reasoning: "London Drugs → Office Supplies", vendor: "London Drugs" },
  { pattern: /\bwalgreens\b/i, account: "Office Supplies", confidence: 0.82, reasoning: "Walgreens → Office Supplies", vendor: "Walgreens" },
  { pattern: /\bcvs\b/i, account: "Office Supplies", confidence: 0.82, reasoning: "CVS → Office Supplies", vendor: "CVS" },
  { pattern: /tim\s+hortons?\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Tim Hortons → Meals (50% deductible)", vendor: "Tim Hortons" },
  { pattern: /\bmcdonald['']?s\b|\bmcd\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "McDonald's → Meals (50% deductible)", vendor: "McDonald's" },
  { pattern: /\bsubway\b(?!.*car)/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Subway → Meals (50% deductible)", vendor: "Subway" },
  { pattern: /\bstarbucks\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Starbucks → Meals (50% deductible)", vendor: "Starbucks" },
  { pattern: /\ba\s*&\s*w\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "A&W → Meals (50% deductible)", vendor: "A&W" },
  { pattern: /dairy\s+queen|\bdq\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Dairy Queen → Meals (50% deductible)", vendor: "Dairy Queen" },
  { pattern: /\bwendy['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Wendy's → Meals (50% deductible)", vendor: "Wendy's" },
  { pattern: /burger\s+king/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Burger King → Meals (50% deductible)", vendor: "Burger King" },
  { pattern: /\bkfc\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "KFC → Meals (50% deductible)", vendor: "KFC" },
  { pattern: /\bpopeyes\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Popeyes → Meals (50% deductible)", vendor: "Popeyes" },
  { pattern: /taco\s+bell/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Taco Bell → Meals (50% deductible)", vendor: "Taco Bell" },
  { pattern: /\bchipotle\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Chipotle → Meals (50% deductible)", vendor: "Chipotle" },
  { pattern: /five\s+guys/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Five Guys → Meals (50% deductible)", vendor: "Five Guys" },
  { pattern: /\bdomino['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Domino's → Meals (50% deductible)", vendor: "Domino's" },
  { pattern: /pizza\s+hut/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Pizza Hut → Meals (50% deductible)", vendor: "Pizza Hut" },
  { pattern: /\bpanera\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Panera → Meals (50% deductible)", vendor: "Panera" },
  { pattern: /booster\s+juice/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Booster Juice → Meals (50% deductible)", vendor: "Booster Juice" },
  { pattern: /jugo\s+juice/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Jugo Juice → Meals (50% deductible)", vendor: "Jugo Juice" },
  { pattern: /second\s+cup/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Second Cup → Meals (50% deductible)", vendor: "Second Cup" },
  { pattern: /\bearls?\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Earls → Meals (50% deductible)", vendor: "Earls" },
  { pattern: /boston\s+pizza/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Boston Pizza → Meals (50% deductible)", vendor: "Boston Pizza" },
  { pattern: /\bjoey['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Joey's → Meals (50% deductible)", vendor: "Joey's" },
  { pattern: /cactus\s+club/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Cactus Club → Meals (50% deductible)", vendor: "Cactus Club" },
  { pattern: /moxie['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Moxie's → Meals (50% deductible)", vendor: "Moxie's" },
  { pattern: /the\s+keg|\bkeg\s+steak/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "The Keg → Meals (50% deductible)", vendor: "The Keg" },
  { pattern: /original\s+joe['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Original Joe's → Meals (50% deductible)", vendor: "Original Joe's" },
  { pattern: /montana['']?s/i, account: "Meals (50% deductible)", confidence: 0.93, reasoning: "Montana's → Meals (50% deductible)", vendor: "Montana's" },
  { pattern: /browns?\s+socialhouse/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Browns Socialhouse → Meals (50% deductible)", vendor: "Browns Socialhouse" },
  { pattern: /\bdenny['’]?s\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Denny's → Meals (50% deductible)", vendor: "Denny's" },
  { pattern: /\bihop\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "IHOP → Meals (50% deductible)", vendor: "IHOP" },
  { pattern: /smitty['’]?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Smitty's → Meals (50% deductible)", vendor: "Smitty's" },
  { pattern: /kelsey['’]?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Kelsey's → Meals (50% deductible)", vendor: "Kelsey's" },
  { pattern: /mr\.?\s+lube/i, account: "Vehicle Repairs", confidence: 0.97, reasoning: "Mr. Lube → Vehicle Repairs", vendor: "Mr. Lube" },
  { pattern: /jiffy\s+lube/i, account: "Vehicle Repairs", confidence: 0.97, reasoning: "Jiffy Lube → Vehicle Repairs", vendor: "Jiffy Lube" },
  { pattern: /mister\s+transmission/i, account: "Vehicle Repairs", confidence: 0.97, reasoning: "Mister Transmission → Vehicle Repairs", vendor: "Mister Transmission" },
  { pattern: /\bmidas\b/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Midas → Vehicle Repairs", vendor: "Midas" },
  { pattern: /kal\s+tire/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Kal Tire → Vehicle Repairs", vendor: "Kal Tire" },
  { pattern: /fountain\s+tire/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Fountain Tire → Vehicle Repairs", vendor: "Fountain Tire" },
  { pattern: /\bok\s+tire\b/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "OK Tire → Vehicle Repairs", vendor: "OK Tire" },
  { pattern: /pep\s+boys/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Pep Boys → Vehicle Repairs", vendor: "Pep Boys" },
  { pattern: /\bautozone\b/i, account: "Vehicle Repairs", confidence: 0.90, reasoning: "AutoZone → Vehicle Repairs", vendor: "AutoZone" },
  { pattern: /waste\s+management|\bwm\s+(canada|inc)/i, account: "Job Disposal Fees", confidence: 0.95, reasoning: "Waste Management → Job Disposal Fees", vendor: "Waste Management" },
  { pattern: /edmonton\s+waste/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "Edmonton Waste → Job Disposal Fees", vendor: "Edmonton Waste" },
  { pattern: /\bbfi\b/i, account: "Job Disposal Fees", confidence: 0.95, reasoning: "BFI → Job Disposal Fees", vendor: "BFI" },
  { pattern: /republic\s+services/i, account: "Job Disposal Fees", confidence: 0.95, reasoning: "Republic Services → Job Disposal Fees", vendor: "Republic Services" },
  { pattern: /gfl\s+environmental/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "GFL → Job Disposal Fees", vendor: "GFL" },
  { pattern: /\bbagster\b/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "Bagster → Job Disposal Fees", vendor: "Bagster" },
  { pattern: /\bgot\s+junk\b|1[\s\-]?800[\s\-]?got[\s\-]?junk/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "1-800-Got-Junk → Job Disposal Fees", vendor: "1-800-Got-Junk" },
  { pattern: /\bdump\s+(fee|station)|transfer\s+station/i, account: "Job Disposal Fees", confidence: 0.93, reasoning: "Job Disposal Fees (keyword match)" },
  { pattern: /state\s+farm/i, account: "Insurance – Other", confidence: 0.85, reasoning: "State Farm → Insurance – Other", vendor: "State Farm" },
  { pattern: /\ballstate\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Allstate → Insurance – Other", vendor: "Allstate" },
  { pattern: /\bgeico\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Geico → Insurance – Other", vendor: "Geico" },
  { pattern: /progressive\s+(ins|claim)/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Progressive → Insurance – Other", vendor: "Progressive" },
  { pattern: /\bintact\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Intact → Insurance – Other", vendor: "Intact" },
  { pattern: /\baviva\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Aviva → Insurance – Other", vendor: "Aviva" },
  { pattern: /wawanes+a/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Wawanesa → Insurance – Other", vendor: "Wawanesa" },
  { pattern: /co[\s\-]?operators/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Co-operators → Insurance – Other", vendor: "Co-operators" },
  { pattern: /\bwsib\b/i, account: "Workers Compensation – Admin", confidence: 0.93, reasoning: "WSIB → Workers Compensation – Admin", vendor: "WSIB" },
  { pattern: /\bwcb\b/i, account: "Workers Compensation – Admin", confidence: 0.93, reasoning: "WCB → Workers Compensation – Admin", vendor: "WCB" },
  { pattern: /blue\s+cross/i, account: "Health Insurance – Owner", confidence: 0.90, reasoning: "Blue Cross → Health Insurance – Owner", vendor: "Blue Cross" },
  { pattern: /google\s*\*?\s*ads\w*|googleads|google\s+adwords/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "Google Ads → Online Advertising", vendor: "Google Ads" },
  { pattern: /google\s*\*?\s*(workspace|suite|gsuite)/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "Google Workspace → Software", vendor: "Google Workspace" },
  { pattern: /\bfacebk\b|\bfb\s*\*|\bmeta\s+(ads|platforms?)\b|facebook\s*ads|instagr?am\s*ads/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "Meta/Facebook ads → Online Advertising", vendor: "Meta" },
  { pattern: /linkedin\s+ads/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "LinkedIn → Online Advertising - Ad Spend", vendor: "LinkedIn" },
  { pattern: /tiktok\s+ads/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "TikTok → Online Advertising - Ad Spend", vendor: "TikTok" },
  { pattern: /snapchat\s+ads/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "Snapchat → Online Advertising - Ad Spend", vendor: "Snapchat" },
  { pattern: /yelp\s+ads/i, account: "Online Advertising - Ad Spend", confidence: 0.93, reasoning: "Yelp → Online Advertising - Ad Spend", vendor: "Yelp" },
  { pattern: /\bangi\b/i, account: "Online Advertising - Ad Spend", confidence: 0.93, reasoning: "Angi → Online Advertising - Ad Spend", vendor: "Angi" },
  { pattern: /home\s*advisor/i, account: "Online Advertising - Ad Spend", confidence: 0.93, reasoning: "HomeAdvisor → Online Advertising - Ad Spend", vendor: "HomeAdvisor" },
  { pattern: /\bhouzz\b/i, account: "Online Advertising - Ad Spend", confidence: 0.93, reasoning: "Houzz → Online Advertising - Ad Spend", vendor: "Houzz" },
  // Intuit sells three different things — the descriptor usually says which:
  // payments/merch = processing fees (Bank Charges); payroll handled above;
  // explicit QBooks/QBO = the software sub. A BARE "INTUIT" with no product
  // qualifier stays at 0.85 — below the 0.90 auto floor — so it queues for a
  // human instead of guessing.
  { pattern: /intuit.{0,12}(pymt|paymt|payment|merch)|quickbooks\s+payments?\b|\bqb\s*pmts?\b/i, account: "Bank Charges", confidence: 0.93, reasoning: "QuickBooks Payments processing fees → Bank Charges", vendor: "Intuit Payments" },
  { pattern: /intuit.{0,8}(qbooks|quickbooks|\bqbo\b)|quickbooks\s+online|\bqbooks\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "QuickBooks Online subscription → Software Subscriptions", vendor: "Intuit" },
  { pattern: /\bquickbooks\b|\bintuit\b/i, account: "Software Subscriptions", confidence: 0.85, reasoning: "Bare Intuit charge — could be subscription, payroll fee, or processing fee; queued for review", vendor: "Intuit" },
  { pattern: /\bxero\b/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "Xero → Software Subscriptions", vendor: "Xero" },
  { pattern: /microsoft|office\s+365|\bms365\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Microsoft → Software Subscriptions", vendor: "Microsoft" },
  { pattern: /\badobe\b/i, account: "Software Subscriptions", confidence: 0.93, reasoning: "Adobe → Software Subscriptions", vendor: "Adobe" },
  { pattern: /\bdropbox\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Dropbox → Software Subscriptions", vendor: "Dropbox" },
  { pattern: /\bslack\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Slack → Software Subscriptions", vendor: "Slack" },
  { pattern: /\bzoom\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Zoom → Software Subscriptions", vendor: "Zoom" },
  { pattern: /\bnotion\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Notion → Software Subscriptions", vendor: "Notion" },
  { pattern: /apple\.com|apple\s+(icloud|services)/i, account: "Software Subscriptions", confidence: 0.90, reasoning: "Apple iCloud → Software Subscriptions", vendor: "Apple iCloud" },
  { pattern: /\bgodaddy\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "GoDaddy → Software Subscriptions", vendor: "GoDaddy" },
  { pattern: /\bsquarespace\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Squarespace → Software Subscriptions", vendor: "Squarespace" },
  { pattern: /\bwix\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Wix → Software Subscriptions", vendor: "Wix" },
  { pattern: /\bshopify\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Shopify → Software Subscriptions", vendor: "Shopify" },
  { pattern: /\bchatgpt\b|\bopenai\b/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "OpenAI → Software Subscriptions", vendor: "OpenAI" },
  { pattern: /anthropic|claude\.ai/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "Anthropic → Software Subscriptions", vendor: "Anthropic" },
  { pattern: /\bjobber\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Jobber → Software Subscriptions", vendor: "Jobber" },
  { pattern: /\bservicetitan\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "ServiceTitan → Software Subscriptions", vendor: "ServiceTitan" },
  { pattern: /\bmarkate\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Markate → Software Subscriptions", vendor: "Markate" },
  { pattern: /\bjoist\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Joist → Software Subscriptions", vendor: "Joist" },
  { pattern: /\bbuildertrend\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "BuilderTrend → Software Subscriptions", vendor: "BuilderTrend" },
  { pattern: /\bcoconstruct\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "CoConstruct → Software Subscriptions", vendor: "CoConstruct" },
  { pattern: /\bfido\b/i, account: "Utilities", confidence: 0.85, reasoning: "Fido → Utilities", vendor: "Fido" },
  { pattern: /\bkoodo\b/i, account: "Utilities", confidence: 0.85, reasoning: "Koodo → Utilities", vendor: "Koodo" },
  { pattern: /virgin\s+mobile/i, account: "Utilities", confidence: 0.85, reasoning: "Virgin Mobile → Utilities", vendor: "Virgin Mobile" },
  { pattern: /freedom\s+mobile/i, account: "Utilities", confidence: 0.85, reasoning: "Freedom Mobile → Utilities", vendor: "Freedom Mobile" },
  { pattern: /air\s+canada/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Air Canada → Travel – Airfare & Lodging", vendor: "Air Canada" },
  { pattern: /\bwestjet\b/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "WestJet → Travel – Airfare & Lodging", vendor: "WestJet" },
  { pattern: /\bporter\s+(airline|escapes)/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Porter Airlines → Travel – Airfare & Lodging", vendor: "Porter Airlines" },
  { pattern: /\bdelta\s+air/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Delta Air Lines → Travel – Airfare & Lodging", vendor: "Delta Air Lines" },
  { pattern: /united\s+airlines/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "United Airlines → Travel – Airfare & Lodging", vendor: "United Airlines" },
  { pattern: /alaska\s+air/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Alaska Airlines → Travel – Airfare & Lodging", vendor: "Alaska Airlines" },
  { pattern: /american\s+airlines/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "American Airlines → Travel – Airfare & Lodging", vendor: "American Airlines" },
  { pattern: /\bhilton\b/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Hilton → Travel – Airfare & Lodging", vendor: "Hilton" },
  { pattern: /\bmarriott\b/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Marriott → Travel – Airfare & Lodging", vendor: "Marriott" },
  { pattern: /holiday\s+inn/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Holiday Inn → Travel – Airfare & Lodging", vendor: "Holiday Inn" },
  { pattern: /hampton\s+inn/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Hampton Inn → Travel – Airfare & Lodging", vendor: "Hampton Inn" },
  { pattern: /\bsheraton\b/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Sheraton → Travel – Airfare & Lodging", vendor: "Sheraton" },
  { pattern: /\bhyatt\b/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Hyatt → Travel – Airfare & Lodging", vendor: "Hyatt" },
  { pattern: /comfort\s+inn/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Comfort Inn → Travel – Airfare & Lodging", vendor: "Comfort Inn" },
  { pattern: /best\s+western/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Best Western → Travel – Airfare & Lodging", vendor: "Best Western" },
  { pattern: /\bexpedia\b/i, account: "Travel – Airfare & Lodging", confidence: 0.95, reasoning: "Expedia → Travel – Airfare & Lodging", vendor: "Expedia" },
  { pattern: /booking\.com/i, account: "Travel – Airfare & Lodging", confidence: 0.95, reasoning: "Booking.com → Travel – Airfare & Lodging", vendor: "Booking.com" },
  { pattern: /\bairbnb\b/i, account: "Travel – Airfare & Lodging", confidence: 0.95, reasoning: "Airbnb → Travel – Airfare & Lodging", vendor: "Airbnb" },
  { pattern: /\bkayak\b/i, account: "Travel – Airfare & Lodging", confidence: 0.95, reasoning: "Kayak → Travel – Airfare & Lodging", vendor: "Kayak" },
  { pattern: /\bstaples\b/i, account: "Office Supplies", confidence: 0.95, reasoning: "Staples → Office Supplies", vendor: "Staples" },
  { pattern: /office\s+depot/i, account: "Office Supplies", confidence: 0.95, reasoning: "Office Depot → Office Supplies", vendor: "Office Depot" },
  { pattern: /canada\s+post/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "Canada Post → Postage & Delivery", vendor: "Canada Post" },
  { pattern: /\busps\b/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "USPS → Postage & Delivery", vendor: "USPS" },
  { pattern: /\bups\s+store|\bups\b(?!\s*s\b)/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "UPS → Postage & Delivery", vendor: "UPS" },
  { pattern: /\bfedex\b/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "FedEx → Postage & Delivery", vendor: "FedEx" },
  { pattern: /\bdhl\b/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "DHL → Postage & Delivery", vendor: "DHL" },
  { pattern: /\bpurolator\b/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "Purolator → Postage & Delivery", vendor: "Purolator" },
  { pattern: /\bcpa\b|chartered\s+(prof|account)|\bca\s+firm|tax\s+(service|prep)|h&r\s+block/i, account: "Accounting & Bookkeeping", confidence: 0.90, reasoning: "Accounting & Bookkeeping (keyword match)" },
  { pattern: /\battorney|\blaw\s+(firm|office)|\blegal\s+services|\bllp\b/i, account: "Legal Fees", confidence: 0.85, reasoning: "Legal Fees (keyword match)" },
  { pattern: /\bshaw\b(?!'?s\b)/i, account: "Utilities", confidence: 0.9, reasoning: "Shaw → Utilities", vendor: "Shaw" },
  { pattern: /\bvideotron\b/i, account: "Utilities", confidence: 0.9, reasoning: "Videotron → Utilities", vendor: "Videotron" },
  { pattern: /\bcomcast\b|\bxfinity\b/i, account: "Utilities", confidence: 0.9, reasoning: "Comcast → Utilities", vendor: "Comcast" },
  { pattern: /\bcogeco\b/i, account: "Utilities", confidence: 0.9, reasoning: "Cogeco → Utilities", vendor: "Cogeco" },
  { pattern: /h&r\s+block|h\s*&\s*r\s+block/i, account: "Accounting & Bookkeeping", confidence: 0.9, reasoning: "H&R Block → Accounting & Bookkeeping", vendor: "H&R Block" },

  // ══════ BARE GOOGLE / FACEBOOK FALLBACKS (keep LAST; low confidence → queue, never auto-post) ══════
  { pattern: /\bfacebook\b(?!\s*market)|\bmeta\b(?!\s*(quest|store))/i, account: "Online Advertising - Ad Spend", confidence: 0.87, reasoning: "Bare Facebook/Meta charge on a business account → most likely ads (queued for review)" },
  { pattern: /\bgoogle\b(?!\s*\*?\s*(workspace|suite|gsuite|one|play|fi\b|storage|cloud|domains|voice|youtube|nest))/i, account: "Online Advertising - Ad Spend", confidence: 0.82, reasoning: "Bare Google charge on a business account → most likely ads (queued for review)" },
];

// ─────────── Lookup function ───────────

/**
 * Normalize a vendor descriptor for matching — strips Interac/debit prefixes
 * and common bank-feed noise so we match the actual merchant name.
 */
export function normalizeVendorForLookup(raw: string): string {
  return (raw || "")
    // Strip common bank-feed prefixes
    .replace(/^(interac\s+(purchase|retail|debit)\s*[\-:]?\s*)/i, "")
    .replace(/^(pos\s+(purchase|debit)\s*[\-:]?\s*)/i, "")
    .replace(/^(debit\s+memo\s*[\-:]?\s*)/i, "")
    // Strip store numbers like "#4592" or "STORE #1234"
    .replace(/\bstore\s*#?\s*\d+\b/gi, "")
    .replace(/#\d+/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical `bank_rules.vendor_pattern` for a vendor name — the ONE form a rule
 * must be stored in so it fires on future auto-categorization.
 *
 * Both engines that consult bank_rules key their in-memory map on
 * `vendor_pattern.toUpperCase()` and look up incoming vendors as
 * `normalizeVendorForLookup(name).toUpperCase()`:
 *   - lib/daily-recon.ts (Tier 2) — exact
 *   - app/api/reclass/discover — same, plus an extra punctuation strip, so a
 *     stored pattern also matches there for clean (alphanumeric) vendor names.
 * Storing this exact value means daily-recon (the ongoing automated engine)
 * always matches the same vendor string, and discover matches clean names.
 * Any writer of bank_rules should use this so patterns stay consistent.
 */
export function bankRuleVendorPattern(name: string): string {
  return normalizeVendorForLookup(name).toUpperCase();
}

/**
 * Look up a vendor against the static knowledge base. Returns the best match
 * or null if no pattern fires.
 *
 * @param vendorName  The vendor descriptor from QBO
 * @param description The transaction line description (additional context)
 * @param amount      The transaction amount (signed)
 * @param industry    Optional client industry — filters industry-specific patterns
 */
export function lookupVendor(
  vendorName: string,
  description: string,
  amount: number,
  industry: string = "painters"
): VendorMatch | null {
  const haystack = `${normalizeVendorForLookup(vendorName)} ${description || ""}`.trim();
  if (!haystack) return null;

  const absAmount = Math.abs(amount);

  for (const p of PATTERNS) {
    // Industry filter
    if (p.industries && !p.industries.includes(industry)) continue;
    // Amount range filter
    if (p.amountRange && (absAmount < p.amountRange[0] || absAmount > p.amountRange[1])) continue;
    // Regex match
    if (p.pattern.test(haystack)) {
      return {
        account: p.account,
        confidence: p.confidence,
        reasoning: p.reasoning,
        vendor: p.vendor,
      };
    }
  }
  return null;
}

/**
 * Extract a KNOWN, NAMED vendor's canonical display name from raw text — used
 * to consolidate per-client bank-rule candidates (Mike, 2026-07-14: rules
 * were "too specific", one per raw bank descriptor, instead of one broad
 * "contains petro-canada" rule covering every phrasing).
 *
 * Deliberately narrower than lookupVendor: only fires on PATTERNS entries
 * that carry an explicit `vendor` field (a real single named brand — the 254
 * Mike/Lisa-reviewed vendors). Category/keyword-only rules (e.g. bare
 * "attorney" → Legal Fees, no `vendor`) are skipped — they're accounts, not
 * a name to group raw bank descriptions under. No amount/industry gating:
 * this is a naming question, not a categorization decision.
 */
export function extractKnownVendorName(text: string): string | null {
  const haystack = normalizeVendorForLookup(text || "");
  if (!haystack) return null;
  for (const p of PATTERNS) {
    if (!p.vendor) continue;
    if (p.pattern.test(haystack)) return p.vendor;
  }
  return null;
}
