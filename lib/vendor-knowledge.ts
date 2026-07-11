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
}

// ─────────── Patterns ───────────
// Order matters: more specific patterns first. First match wins.

const PATTERNS: VendorPattern[] = [
  // ══════════════════ ATM WITHDRAWALS → Owner Draw ══════════════════
  // Cash withdrawn from ATM is essentially untracked spending — booked to owner
  // draw by default for trades businesses (rules vary by client but this is the
  // safest default).
  { pattern: /\batm\s+(withdrawal|wd|w\/d|cash|debit)/i, account: "Owner's Draw", confidence: 0.95, reasoning: "ATM Withdrawal → Owner Draw (untracked cash)" },
  { pattern: /\bwithdrawal\s*[\-:]\s*atm/i, account: "Owner's Draw", confidence: 0.95, reasoning: "ATM Withdrawal → Owner Draw" },
  { pattern: /^atm\b/i, account: "Owner's Draw", confidence: 0.88, reasoning: "ATM transaction → Owner Draw" },

  // ══════════════════ E-TRANSFER FEE — tiny amounts ALWAYS bank fee ══════════════════
  // Canadian banks charge $1-$1.50 per e-transfer. Anything sub-$2 with "e-transfer"
  // language anywhere in the descriptor is unambiguously a fee. Broad regex catches
  // all variants: "E-TRANSFER", "ETRANSFER", "E-TFR", "ETFR", "EMT", "Interac E-Transfer".
  { pattern: /e[\s\-]?transfer/i, account: "Bank Charges", confidence: 0.99, reasoning: "e-Transfer < $2 → Bank Charges (fee)", amountRange: [0, 2] },
  { pattern: /\be[\s\-]?tfr\b/i, account: "Bank Charges", confidence: 0.99, reasoning: "e-Tfr < $2 → Bank Charges (fee)", amountRange: [0, 2] },
  { pattern: /\bemt\b/i, account: "Bank Charges", confidence: 0.99, reasoning: "EMT < $2 → Bank Charges (fee)", amountRange: [0, 2] },
  // Generic "fee" + tiny amount also bank charges, regardless of e-transfer wording
  { pattern: /\b(fee|service\s+charge|nsf|overdraft)\b/i, account: "Bank Charges", confidence: 0.97, reasoning: "Small fee/service charge → Bank Charges", amountRange: [0, 5] },

  // ══════════════════ GYMS → Owner Draw ══════════════════
  // Personal fitness memberships almost always = owner draw for trades clients
  { pattern: /\bfit4less\b/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Fit4Less → Owner Draw (personal)" },
  { pattern: /good\s*life\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "GoodLife Fitness → Owner Draw (personal)" },
  { pattern: /anytime\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Anytime Fitness → Owner Draw (personal)" },
  { pattern: /\bplanet\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Planet Fitness → Owner Draw (personal)" },
  { pattern: /\bworld\s+gym\b/i, account: "Owner's Draw", confidence: 0.95, reasoning: "World Gym → Owner Draw (personal)" },
  { pattern: /\bcrunch\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Crunch Fitness → Owner Draw (personal)" },
  { pattern: /\b(la|24\s*hour)\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "LA/24h Fitness → Owner Draw (personal)" },
  { pattern: /\borange\s*theory/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Orangetheory → Owner Draw (personal)" },
  { pattern: /\b(curves|f45|crossfit)\b/i, account: "Owner's Draw", confidence: 0.93, reasoning: "Gym/CrossFit → Owner Draw (personal)" },
  { pattern: /\byoga\s+(studio|barn|works)/i, account: "Owner's Draw", confidence: 0.90, reasoning: "Yoga studio → Owner Draw (personal)" },

  // ══════════════════ GROCERY STORES → Employee Benefits (employee appreciation) ══════════════════
  // Trades clients buying groceries are usually doing it for crew lunches /
  // employee appreciation. Default to Employee Benefits.
  { pattern: /\bfresh[\s\-]?co\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Freshco → Employee Benefits (crew snacks/appreciation)" },
  { pattern: /save[\s\-]?on[\s\-]?foods/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Save-On-Foods → Employee Benefits" },
  { pattern: /\bsobeys\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Sobeys → Employee Benefits" },
  { pattern: /\bloblaws?\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Loblaws → Employee Benefits" },
  { pattern: /real\s+canadian\s+superstore|\bsuperstore\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Superstore → Employee Benefits" },
  { pattern: /\biga\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "IGA → Employee Benefits" },
  { pattern: /\bsafeway\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Safeway → Employee Benefits" },
  { pattern: /\bco[\s\-]?op\s+food/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Co-op Food → Employee Benefits" },
  { pattern: /\bno\s+frills\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "No Frills → Employee Benefits" },
  { pattern: /\bmetro\b\s*(grocer|food)?/i, account: "Employee Benefits – Admin & Sales", confidence: 0.85, reasoning: "Metro grocery → Employee Benefits" },
  { pattern: /\bt\s*&\s*t\s+supermarket|t\&t\s+market/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "T&T Supermarket → Employee Benefits" },
  { pattern: /\bfortinos\b|\bzehrs\b|\bvalu[\s\-]?mart/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Loblaws-family grocery → Employee Benefits" },

  // ══════════════════ WALMART → Office Supplies ══════════════════
  { pattern: /\bwalmart\b|\bwal[\s\-]?mart\b/i, account: "Office Supplies", confidence: 0.92, reasoning: "Walmart → Office Supplies" },

  // ══════════════════ COSTCO DISAMBIGUATION (most specific first) ══════════════════
  { pattern: /costco\s*(gas|fuel|cardlock)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Costco Gas → Fuel" },
  { pattern: /costco\s*(food court|restaurant)/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Costco Food Court → Meals" },
  { pattern: /costco\s*(whse|wholesale|business)/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Costco Wholesale → Job Supplies (default for trades)" },

  // ══════════════════ GAS STATION SMALL PURCHASES → MEALS (before the fuel block: first match wins) ══════════════════
  // A sub-$15 charge at a retail gas station is a coffee/snack, not a fill-up
  // (bookkeeper feedback: these were all landing in Fuel and getting hand-moved
  // to Meals one by one). Confidence 0.90 sits below the 0.95 auto-execute
  // floor, so these QUEUE for review rather than auto-posting; promote after
  // Lisa confirms the queue looks right. Deliberately excludes pay-at-pump-only
  // and commercial cardlock vendors (Costco Gas, Petro-Pass, Co-op Cardlock,
  // Hughes) where a small amount is still fuel.
  { pattern: /\bessom?\b|\bshell\b(?!.*lube)|\bchevron\b|petro[\s\-]?canada|\bhusky\b|\bdomo\b|\bfasgas\b|\bcentex\b|\bmohawk\b|pioneer\s+(gas|station)|\b7[\s\-]?eleven\b|\bcircle\s*k\b|\brace\s*trac\b|\bspeedway\b|\bsunoco\b|\b(mobil|exxon)\b/i,
    account: "Meals (50% deductible)", confidence: 0.90, reasoning: "Small gas-station purchase (≤$15) → likely snack/coffee, not fuel", amountRange: [0, 15] },

  // ══════════════════ FUEL / GAS STATIONS ══════════════════
  { pattern: /\bessom?\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Esso → Fuel" },
  { pattern: /\bshell\b(?!.*lube)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Shell → Fuel" },
  { pattern: /\bchevron\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Chevron → Fuel" },
  { pattern: /petro[\s\-]?canada/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Petro-Canada → Fuel" },
  { pattern: /\bpetro[\s\-]?pass\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Petro-Pass → Fuel" },
  { pattern: /\bhusky\b(?!.*travel)/i, account: "Fuel – Overhead", confidence: 0.93, reasoning: "Husky → Fuel" },
  { pattern: /\bhusky\s+travel/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Husky Travel Centre → Fuel" },
  { pattern: /hughes\s+petroleum/i, account: "Fuel – Overhead", confidence: 0.97, reasoning: "Hughes Petroleum → Fuel" },
  { pattern: /\bco[\s\-]?op\s+(gas|cardlock|fuel)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Co-op Gas/Cardlock → Fuel" },
  { pattern: /federated\s+co[\s\-]?op/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Federated Co-op → Fuel (likely)" },
  { pattern: /\bdomo\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Domo → Fuel" },
  { pattern: /\bfasgas\b/i, account: "Fuel – Overhead", confidence: 0.93, reasoning: "FasGas → Fuel" },
  { pattern: /\bcentex\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Centex → Fuel" },
  { pattern: /\bmohawk\b/i, account: "Fuel – Overhead", confidence: 0.88, reasoning: "Mohawk → Fuel" },
  { pattern: /\bmacewen\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Macewen → Fuel" },
  { pattern: /pioneer\s+(gas|station)/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Pioneer Gas → Fuel" },
  { pattern: /\b7[\s\-]?eleven\b/i, account: "Fuel – Overhead", confidence: 0.85, reasoning: "7-Eleven → Fuel (convenience+gas)" },
  { pattern: /\bcircle\s*k\b/i, account: "Fuel – Overhead", confidence: 0.85, reasoning: "Circle K → Fuel" },
  { pattern: /\brace\s*trac\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Race Trac → Fuel" },
  { pattern: /\bspeedway\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Speedway → Fuel" },
  { pattern: /\bsunoco\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Sunoco → Fuel" },
  { pattern: /\b(mobil|exxon)\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Mobil/Exxon → Fuel" },
  { pattern: /\bbp\s+(gas|fuel)/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "BP → Fuel" },

  // ══════════════════ PAINT SUPPLIERS (painters only) ══════════════════
  { pattern: /sherwin[\s\-]?williams|^sw\s+(paint|stores)/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Sherwin-Williams → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /benjamin\s+moore|\bbm\s+paint/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Benjamin Moore → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /dunn[\s\-]?edwards/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Dunn-Edwards → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /\bppg\b/i, account: "Job Supplies & Materials", confidence: 0.92, reasoning: "PPG → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /para\s+paint/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Para Paints → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /cloverdale\s+paint/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Cloverdale Paint → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /general\s+paint/i, account: "Job Supplies & Materials", confidence: 0.92, reasoning: "General Paint → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /kelly[\s\-]?moore/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Kelly-Moore → Job Supplies & Materials", industries: ["painters"] },
  { pattern: /\bbehr\b/i, account: "Job Supplies & Materials", confidence: 0.90, reasoning: "Behr Paint → Job Supplies & Materials", industries: ["painters"] },

  // ══════════════════ HARDWARE / JOB SUPPLIES ══════════════════
  { pattern: /home\s+depot|\bhd\s+supply/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Home Depot → Job Supplies & Materials" },
  { pattern: /\blowes\b|\blowe['']?s\b/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Lowe's → Job Supplies & Materials" },
  { pattern: /\brona\b/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Rona → Job Supplies & Materials" },
  { pattern: /canadian\s+tire/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Canadian Tire → Job Supplies (likely)" },
  { pattern: /\bace\s+hardware/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Ace Hardware → Job Supplies & Materials" },
  { pattern: /princess\s+auto/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Princess Auto → Job Supplies / Small Tools" },
  { pattern: /\btsc\s+stores|tractor\s+supply/i, account: "Job Supplies & Materials", confidence: 0.90, reasoning: "TSC → Job Supplies & Materials" },
  { pattern: /shoppers\s+drug\s+mart|\bsdm\b/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Shoppers Drug Mart → Job Supplies (small consumables)" },
  { pattern: /london\s+drugs/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "London Drugs → Job Supplies & Materials" },
  { pattern: /\bwalgreens\b/i, account: "Job Supplies & Materials", confidence: 0.82, reasoning: "Walgreens → Job Supplies (small consumables)" },
  { pattern: /\bcvs\b/i, account: "Job Supplies & Materials", confidence: 0.82, reasoning: "CVS → Job Supplies & Materials" },

  // ══════════════════ MEALS — quick-service ══════════════════
  { pattern: /tim\s+hortons?\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Tim Hortons → Meals" },
  { pattern: /\bmcdonald['']?s\b|\bmcd\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "McDonald's → Meals" },
  { pattern: /\bsubway\b(?!.*car)/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Subway → Meals" },
  { pattern: /\bstarbucks\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Starbucks → Meals" },
  { pattern: /\ba\s*&\s*w\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "A&W → Meals" },
  { pattern: /dairy\s+queen|\bdq\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Dairy Queen → Meals" },
  { pattern: /\bwendy['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Wendy's → Meals" },
  { pattern: /burger\s+king/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Burger King → Meals" },
  { pattern: /\bkfc\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "KFC → Meals" },
  { pattern: /\bpopeyes\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Popeyes → Meals" },
  { pattern: /taco\s+bell/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Taco Bell → Meals" },
  { pattern: /\bchipotle\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Chipotle → Meals" },
  { pattern: /five\s+guys/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Five Guys → Meals" },
  { pattern: /\bdomino['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Domino's → Meals" },
  { pattern: /pizza\s+hut/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Pizza Hut → Meals" },
  { pattern: /\bpanera\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Panera → Meals" },
  { pattern: /booster\s+juice|jugo\s+juice|second\s+cup/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Juice/Coffee → Meals" },

  // ══════════════════ MEALS — sit-down ══════════════════
  { pattern: /\bearls?\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Earls → Meals" },
  { pattern: /boston\s+pizza/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Boston Pizza → Meals" },
  { pattern: /\bjoey['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Joey's → Meals" },
  { pattern: /cactus\s+club/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Cactus Club → Meals" },
  { pattern: /moxie['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Moxie's → Meals" },
  { pattern: /the\s+keg|\bkeg\s+steak/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "The Keg → Meals" },
  { pattern: /original\s+joe['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Original Joe's → Meals" },
  { pattern: /montana['']?s/i, account: "Meals (50% deductible)", confidence: 0.93, reasoning: "Montana's → Meals" },
  { pattern: /browns?\s+socialhouse/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Browns Socialhouse → Meals" },
  { pattern: /\bdenny['']?s\b|\bihop\b|smitty['']?s|kelsey['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Family restaurant chain → Meals" },

  // ══════════════════ VEHICLE REPAIRS ══════════════════
  { pattern: /mr\.?\s+lube|jiffy\s+lube/i, account: "Vehicle Repairs", confidence: 0.97, reasoning: "Lube shop → Vehicle Repairs" },
  { pattern: /mister\s+transmission/i, account: "Vehicle Repairs", confidence: 0.97, reasoning: "Mister Transmission → Vehicle Repairs" },
  { pattern: /\bmidas\b/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Midas → Vehicle Repairs" },
  { pattern: /kal\s+tire|fountain\s+tire|ok\s+tire/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Tire shop → Vehicle Repairs" },
  { pattern: /canadian\s+tire\s+(auto|car)/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Canadian Tire Auto → Vehicle Repairs" },
  { pattern: /pep\s+boys/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Pep Boys → Vehicle Repairs" },
  { pattern: /\bautozone\b/i, account: "Vehicle Repairs", confidence: 0.90, reasoning: "AutoZone → Vehicle Repairs" },

  // ══════════════════ JOB DISPOSAL ══════════════════
  { pattern: /waste\s+management|\bwm\s+(canada|inc)/i, account: "Job Disposal Fees", confidence: 0.95, reasoning: "Waste Management → Job Disposal Fees" },
  { pattern: /edmonton\s+waste/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "Edmonton Waste → Job Disposal Fees" },
  { pattern: /\bbfi\b|republic\s+services/i, account: "Job Disposal Fees", confidence: 0.95, reasoning: "BFI/Republic → Job Disposal Fees" },
  { pattern: /gfl\s+environmental/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "GFL → Job Disposal Fees" },
  { pattern: /\bbagster\b|\bgot\s+junk\b|1[\s\-]?800[\s\-]?got[\s\-]?junk/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "Junk removal → Job Disposal Fees" },
  { pattern: /\bdump\s+(fee|station)|transfer\s+station/i, account: "Job Disposal Fees", confidence: 0.93, reasoning: "Dump/Transfer station → Job Disposal Fees" },

  // ══════════════════ BANK CHARGES ══════════════════
  { pattern: /\bnsf\s+fee|nsf\s+charge/i, account: "Bank Charges", confidence: 0.99, reasoning: "NSF Fee → Bank Charges" },
  { pattern: /overdraft\s+fee/i, account: "Bank Charges", confidence: 0.99, reasoning: "Overdraft Fee → Bank Charges" },
  { pattern: /bank\s+service\s+charge|monthly\s+plan\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Bank Service Charge → Bank Charges" },
  { pattern: /stop\s+payment\s+fee|wire\s+fee|wire\s+transfer\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Wire/Stop-payment fee → Bank Charges" },
  { pattern: /interac\s+e[\s\-]?transfer\s+fee|e[\s\-]?tfr\s+fee|emt\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Interac e-Transfer Fee → Bank Charges" },

  // ══════════════════ INSURANCE ══════════════════
  { pattern: /state\s+farm/i, account: "Insurance – Other", confidence: 0.85, reasoning: "State Farm → Insurance" },
  { pattern: /\ballstate\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Allstate → Insurance" },
  { pattern: /\bgeico\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Geico → Insurance" },
  { pattern: /progressive\s+(ins|claim)/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Progressive → Insurance" },
  { pattern: /\bintact\b|\baviva\b|wawanesa|co[\s\-]?operators/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Canadian insurer → Insurance" },
  { pattern: /\bwsib\b|\bwcb\b/i, account: "Workers Compensation – Admin", confidence: 0.93, reasoning: "WSIB/WCB → Workers Comp" },
  { pattern: /blue\s+cross/i, account: "Health Insurance – Owner", confidence: 0.90, reasoning: "Blue Cross → Health Insurance" },

  // ══════════════════ ADVERTISING ══════════════════
  // Real bank feeds don't say "Google Ads" — they say GOOGLE*ADS4739, GOOGLEADS,
  // FACEBK *X2A7B9, FB *ADVERTISING. Cover the descriptor forms explicitly
  // (bookkeeper feedback: these were falling through to AI and landing in
  // Software Subscriptions).
  { pattern: /google\s*\*?\s*ads\w*|googleads|google\s+adwords/i, account: "Online Advertising – Google Ads / Social Media Marketing", confidence: 0.97, reasoning: "Google Ads → Online Advertising" },
  { pattern: /\bfacebk\b|\bfb\s*\*|\bmeta\s+(ads|platforms?)\b|facebook\s*ads|instagr?am\s*ads/i, account: "Online Advertising – Google Ads / Social Media Marketing", confidence: 0.97, reasoning: "Meta/Facebook descriptor → Online Advertising" },
  { pattern: /linkedin\s+ads|tiktok\s+ads|snapchat\s+ads/i, account: "Online Advertising – Google Ads / Social Media Marketing", confidence: 0.97, reasoning: "Social ads → Online Advertising" },
  { pattern: /yelp\s+ads|\bangi\b|home\s*advisor|\bhouzz\b/i, account: "Online Advertising – Google Ads / Social Media Marketing", confidence: 0.93, reasoning: "Lead-gen platform → Online Advertising" },

  // ══════════════════ SOFTWARE ══════════════════
  { pattern: /quickbooks|\bintuit\b/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "QuickBooks/Intuit → Software" },
  { pattern: /\bxero\b/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "Xero → Software" },
  { pattern: /microsoft|office\s+365|\bms365\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Microsoft → Software" },
  { pattern: /google\s*\*?\s*(workspace|suite|gsuite)/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "Google Workspace → Software" },
  { pattern: /\badobe\b/i, account: "Software Subscriptions", confidence: 0.93, reasoning: "Adobe → Software" },
  { pattern: /\bdropbox\b|\bslack\b|\bzoom\b|\bnotion\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Tech subscription → Software" },
  { pattern: /apple\.com|apple\s+(icloud|services)/i, account: "Software Subscriptions", confidence: 0.90, reasoning: "Apple iCloud → Software" },
  { pattern: /\bgodaddy\b|squarespace|\bwix\b|shopify/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Web hosting → Software" },
  { pattern: /chatgpt|openai|anthropic|claude\.ai/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "AI subscription → Software" },
  { pattern: /\bjobber\b|housecall\s+pro|servicetitan|markate|\bjoist\b/i, account: "Marketing Tools", confidence: 0.95, reasoning: "Trades CRM → Marketing Tools" },
  { pattern: /buildertrend|coconstruct/i, account: "Marketing Tools", confidence: 0.95, reasoning: "Construction PM → Marketing Tools" },

  // ══════════════════ TELECOM ══════════════════
  { pattern: /\brogers\b|\bbell\b\s*(canada|mobility)|\btelus\b|\bfido\b|\bkoodo\b|virgin\s+mobile|freedom\s+mobile/i, account: "Software Subscriptions", confidence: 0.85, reasoning: "Canadian carrier → Software Subscriptions" },
  { pattern: /\bverizon\b|\bat&t\b|t[\s\-]?mobile/i, account: "Software Subscriptions", confidence: 0.85, reasoning: "US carrier → Software Subscriptions" },
  { pattern: /\bcomcast\b|spectrum|\bshaw\b|\bcogeco\b/i, account: "Software Subscriptions", confidence: 0.85, reasoning: "Cable/Internet → Software Subscriptions" },

  // ══════════════════ TRAVEL ══════════════════
  { pattern: /air\s+canada|\bwestjet\b|\bporter\s+(airline|escapes)/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Canadian airline → Travel" },
  { pattern: /\bdelta\s+air|united\s+airlines|alaska\s+air|american\s+airlines/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "US airline → Travel" },
  { pattern: /\bhilton\b|\bmarriott\b|holiday\s+inn|hampton\s+inn|sheraton|\bhyatt\b|comfort\s+inn|best\s+western/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Hotel chain → Travel" },
  { pattern: /\bexpedia\b|booking\.com|\bairbnb\b|\bkayak\b/i, account: "Travel – Airfare & Lodging", confidence: 0.95, reasoning: "Travel platform → Travel" },

  // ══════════════════ OFFICE SUPPLIES ══════════════════
  { pattern: /\bstaples\b/i, account: "Office Supplies", confidence: 0.95, reasoning: "Staples → Office Supplies" },
  { pattern: /office\s+depot/i, account: "Office Supplies", confidence: 0.95, reasoning: "Office Depot → Office Supplies" },

  // ══════════════════ POSTAGE & DELIVERY ══════════════════
  { pattern: /canada\s+post|\busps\b|\bups\s+store|\bfedex\b|\bdhl\b|purolator/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "Shipping → Postage & Delivery" },

  // ══════════════════ ACCOUNTING / LEGAL ══════════════════
  { pattern: /\bcpa\b|chartered\s+(prof|account)|\bca\s+firm|tax\s+(service|prep)|h&r\s+block/i, account: "Accounting & Bookkeeping", confidence: 0.90, reasoning: "Accountant → Accounting & Bookkeeping" },
  { pattern: /\battorney|\blaw\s+(firm|office)|\blegal\s+services|\bllp\b/i, account: "Legal Fees", confidence: 0.85, reasoning: "Legal services → Legal Fees" },

  // ══════════════════ BARE GOOGLE / FACEBOOK FALLBACKS (keep LAST: every specific form above wins first) ══════════════════
  // For a trades contractor, a bare GOOGLE or FACEBOOK charge is almost always
  // advertising, not software. Confidence sits below the auto-execute floor so
  // these queue for a human instead of posting; the lookaheads keep consumer
  // Google products (One/Play/YouTube/Fi/etc.) out of the net.
  { pattern: /\bfacebook\b(?!\s*market)|\bmeta\b(?!\s*(quest|store))/i, account: "Online Advertising – Google Ads / Social Media Marketing", confidence: 0.87, reasoning: "Bare Facebook/Meta charge on a business account → most likely ads (queued for review)" },
  { pattern: /\bgoogle\b(?!\s*\*?\s*(workspace|suite|gsuite|one|play|fi\b|storage|cloud|domains|voice|youtube|nest))/i, account: "Online Advertising – Google Ads / Social Media Marketing", confidence: 0.82, reasoning: "Bare Google charge on a business account → most likely ads (queued for review)" },
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
      };
    }
  }
  return null;
}
