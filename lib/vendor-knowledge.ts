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
  // ══════════════ REVIEWED FLEET VENDORS (from 85K-txn mining, Mike/Lisa reviewed 2026-07) ══════════════
  { pattern: /vistaprint/i, account: "Online Advertising - Ad Spend", confidence: 0.9, reasoning: "VISTAPRINT → Online Advertising - Ad Spend (reviewed)", vendor: "Vistaprint" },
  { pattern: /indeed/i, account: "Recruiting", confidence: 0.9, reasoning: "INDEED → Recruiting (reviewed)", vendor: "Indeed" },
  { pattern: /painter\s+growth\s+venture/i, account: "Continuing Education / Professional Development", confidence: 0.9, reasoning: "PAINTER GROWTH VENTURE → Continuing Education / Professional Development (reviewed)", vendor: "Painter Growth" },
  { pattern: /dripjobs/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "DRIPJOBS → Software Subscriptions (reviewed)", vendor: "Dripjobs" },
  { pattern: /ironbooks\s+financial/i, account: "Accounting & Bookkeeping", confidence: 0.9, reasoning: "IRONBOOKS FINANCIAL → Accounting & Bookkeeping (reviewed)", vendor: "Ironbooks Financial" },
  { pattern: /target/i, account: "Office Supplies", confidence: 0.9, reasoning: "TARGET → Office Supplies (reviewed)" },
  { pattern: /painter\s+growth/i, account: "Continuing Education / Professional Development", confidence: 0.9, reasoning: "PAINTER GROWTH → Continuing Education / Professional Development (reviewed)", vendor: "Painter Growth" },
  { pattern: /canva/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "CANVA → Software Subscriptions (reviewed)" },
  { pattern: /verizon/i, account: "Utilities", confidence: 0.9, reasoning: "VERIZON → Utilities (reviewed)", vendor: "Verizon" },
  { pattern: /at\&t/i, account: "Utilities", confidence: 0.9, reasoning: "AT&T → Utilities (reviewed)", vendor: "AT&T" },
  { pattern: /zapier/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "ZAPIER → Software Subscriptions (reviewed)", vendor: "Zapier" },
  { pattern: /harbor\s+freight\s+tools/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "HARBOR FREIGHT TOOLS → Job Supplies & Materials (reviewed)", vendor: "Harbor Freight Tools" },
  { pattern: /casey/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "CASEY → Fuel – Overhead (reviewed)", vendor: "Casey" },
  { pattern: /gusto/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "GUSTO → Payroll Expenses (reviewed)" },
  { pattern: /chick\s+fil/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "CHICK FIL → Meals (50% deductible) (reviewed)", vendor: "Chick Fil A" },
  { pattern: /best\s+buy/i, account: "Office Supplies", confidence: 0.9, reasoning: "BEST BUY → Office Supplies (reviewed)", vendor: "Best Buy" },
  { pattern: /dollarama/i, account: "Office Supplies", confidence: 0.9, reasoning: "DOLLARAMA → Office Supplies (reviewed)", vendor: "Dollarama" },
  { pattern: /better\s+business\s+bureau/i, account: "Marketing Tools", confidence: 0.9, reasoning: "BETTER BUSINESS BUREAU → Marketing Tools (reviewed)", vendor: "Better Business Bureau" },
  { pattern: /menards/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "MENARDS → Job Supplies & Materials (reviewed)", vendor: "Menards" },
  { pattern: /dunkin\s+donuts/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "DUNKIN DONUTS → Meals (50% deductible) (reviewed)", vendor: "Dunkin Donuts" },
  { pattern: /mailchimp/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "MAILCHIMP → Software Subscriptions (reviewed)", vendor: "Mailchimp" },
  { pattern: /marathon/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "MARATHON → Fuel – Overhead (reviewed)", vendor: "Marathon" },
  { pattern: /drip\s+jobs/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "DRIP JOBS → Software Subscriptions (reviewed)" },
  { pattern: /thumbtack/i, account: "Online Advertising - Ad Spend", confidence: 0.9, reasoning: "THUMBTACK → Online Advertising - Ad Spend (reviewed)", vendor: "Thumbtack" },
  { pattern: /spectrum/i, account: "Utilities", confidence: 0.9, reasoning: "SPECTRUM → Utilities (reviewed)", vendor: "Spectrum" },
  { pattern: /wawa/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "WAWA → Fuel – Overhead (reviewed)", vendor: "Wawa" },
  { pattern: /dulux\s+paints/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "DULUX PAINTS → Job Supplies & Materials (reviewed)", vendor: "Dulux Paints" },
  { pattern: /kwik\s+trip/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "KWIK TRIP → Fuel – Overhead (reviewed)", vendor: "Kwik Trip" },
  { pattern: /quickbooks\s+payroll/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "QUICKBOOKS PAYROLL → Payroll Expenses (reviewed)" },
  { pattern: /uber\s+eats/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "UBER EATS → Meals (50% deductible) (reviewed)", vendor: "Uber Eats" },
  { pattern: /stop\s+shop/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "STOP SHOP → Fuel – Overhead (reviewed)" },
  { pattern: /paychex/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "PAYCHEX → Payroll Expenses (reviewed)" },
  { pattern: /hartford/i, account: "Insurance – Other", confidence: 0.9, reasoning: "THE HARTFORD → Insurance – Other (reviewed)", vendor: "The Hartford" },
  { pattern: /safeway/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "SAFEWAY → Job Supplies & Materials (reviewed)", vendor: "Safeway" },
  { pattern: /paint\s+scout/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "PAINT SCOUT → Software Subscriptions (reviewed)" },
  { pattern: /telus/i, account: "Utilities", confidence: 0.9, reasoning: "TELUS → Utilities (reviewed)", vendor: "Telus" },
  { pattern: /netflix/i, account: "Owner's Draw", confidence: 0.9, reasoning: "NETFLIX → Owner's Draw (reviewed)", vendor: "Netflix" },
  { pattern: /pioneer/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "PIONEER → Fuel – Overhead (reviewed)", vendor: "Pioneer" },
  { pattern: /prime\s+video/i, account: "Owner's Draw", confidence: 0.9, reasoning: "PRIME VIDEO → Owner's Draw (reviewed)", vendor: "Prime Video" },
  { pattern: /next\s+insurance/i, account: "CGL Insurance", confidence: 0.9, reasoning: "NEXT INSURANCE → CGL Insurance (reviewed)", vendor: "Next Insurance" },
  { pattern: /quiktrip/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "QUIKTRIP → Fuel – Overhead (reviewed)", vendor: "Quiktrip" },
  { pattern: /cox\s+communications/i, account: "Utilities", confidence: 0.9, reasoning: "COX COMMUNICATIONS → Utilities (reviewed)", vendor: "Cox Communications" },
  { pattern: /adp/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "ADP → Payroll Expenses (reviewed)" },
  { pattern: /dulux/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "DULUX → Job Supplies & Materials (reviewed)", vendor: "Dulux" },
  { pattern: /rogers/i, account: "Utilities", confidence: 0.9, reasoning: "ROGERS → Utilities (reviewed)", vendor: "Rogers" },
  { pattern: /menard/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "MENARD → Job Supplies & Materials (reviewed)", vendor: "Menard" },
  { pattern: /fanbasis/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "FANBASIS → Software Subscriptions (reviewed)", vendor: "Fanbasis" },
  { pattern: /ez\s+pass/i, account: "Permit Fees", confidence: 0.9, reasoning: "EZ PASS → Permit Fees (reviewed)", vendor: "EZ Pass" },
  { pattern: /playstation\s+network/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "PLAYSTATION NETWORK → Software Subscriptions (reviewed)", vendor: "Playstation Network" },
  { pattern: /fanbasis\s+com/i, account: "Continuing Education / Professional Development", confidence: 0.9, reasoning: "FANBASIS COM → Continuing Education / Professional Development (reviewed)", vendor: "Fanbasis" },
  { pattern: /combined\s+insurance/i, account: "Insurance – Other", confidence: 0.9, reasoning: "COMBINED INSURANCE → Insurance – Other (reviewed)", vendor: "Combined Insurance" },
  { pattern: /sheetz/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "SHEETZ → Fuel – Overhead (reviewed)" },
  { pattern: /bell\s+mobility/i, account: "Utilities", confidence: 0.9, reasoning: "BELL MOBILITY → Utilities (reviewed)", vendor: "Bell Mobility" },
  { pattern: /housecall\s+pro/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "HOUSECALL PRO → Software Subscriptions (reviewed)", vendor: "Housecall Pro" },
  { pattern: /save\s+on\s+foods/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "SAVE ON FOODS → Job Supplies & Materials (reviewed)", vendor: "Save On Foods" },
  { pattern: /sherwin/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "WITHDRAWAL FIP SHERWIN → Job Supplies & Materials (reviewed)", vendor: "Sherwin Williams" },
  { pattern: /quick\s+trip/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "QUICK TRIP → Fuel – Overhead (reviewed)", vendor: "Quick Trip" },
  { pattern: /publick/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "THE PUBLICK → Meals (50% deductible) (reviewed)", vendor: "The Publick" },
  { pattern: /paint\s+depot/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "PAINT DEPOT → Job Supplies & Materials (reviewed)", vendor: "Paint Depot" },
  { pattern: /five\s+star\s+painting/i, account: "Subcontractors", confidence: 0.9, reasoning: "FIVE STAR PAINTING → Subcontractors (reviewed)", vendor: "Five Star Painting" },
  { pattern: /tmobile/i, account: "Utilities", confidence: 0.9, reasoning: "WITHDRAWAL FIS TMOBILE → Utilities (reviewed)", vendor: "T-Mobile" },
  { pattern: /hughes\s+petroleu/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "HUGHES PETROLEU → Fuel – Overhead (reviewed)", vendor: "Hughes Petroleum" },
  { pattern: /floor\s+decor/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "FLOOR DECOR → Job Supplies & Materials (reviewed)", vendor: "Floor Decor" },
  { pattern: /quicken/i, account: "Software Subscriptions", confidence: 0.9, reasoning: "QUICKEN → Software Subscriptions (reviewed)", vendor: "Quicken" },
  { pattern: /freshco/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "FRESHCO → Meals (50% deductible) (reviewed)", vendor: "Freshco" },
  { pattern: /paycor/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "PAYCOR → Payroll Expenses (reviewed)" },
  { pattern: /paylocity/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "PAYLOCITY → Payroll Expenses (reviewed)" },
  { pattern: /beans\s+cafe/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "BEANS CAFE → Meals (50% deductible) (reviewed)", vendor: "Beans Cafe" },
  { pattern: /washington\s+township\s+small/i, account: "Licenses", confidence: 0.9, reasoning: "WASHINGTON TOWNSHIP SMALL → Licenses (reviewed)", vendor: "Washington Township Small" },
  { pattern: /eversource\s+web\s+pay/i, account: "Utilities", confidence: 0.9, reasoning: "EVERSOURCE WEB PAY → Utilities (reviewed)", vendor: "Eversource Web Pay" },
  { pattern: /adp\s+payroll/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "ADP PAYROLL → Payroll Expenses (reviewed)" },
  { pattern: /thumbtack\s+marke/i, account: "Online Advertising - Ad Spend", confidence: 0.9, reasoning: "FIS THUMBTACK MARKE → Online Advertising - Ad Spend (reviewed)", vendor: "Thumbtack" },
  { pattern: /repcolite/i, account: "Job Supplies & Materials", confidence: 0.9, reasoning: "REPCOLITE → Job Supplies & Materials (reviewed)", vendor: "Repcolite" },
  { pattern: /wex\s+inc\s+fleet/i, account: "Fuel – Overhead", confidence: 0.9, reasoning: "WEX INC FLEET → Fuel – Overhead (reviewed)", vendor: "Wex Fleet" },
  { pattern: /national\s+grid/i, account: "Utilities", confidence: 0.9, reasoning: "NATIONAL GRID → Utilities (reviewed)", vendor: "National Grid" },
  { pattern: /clickgrow/i, account: "Online Advertising - Ad Spend", confidence: 0.9, reasoning: "WITHDRAWAL FIS CLICKGROW → Online Advertising - Ad Spend (reviewed)" },
  { pattern: /southern\s+oak\s+gift/i, account: "Meals (50% deductible)", confidence: 0.9, reasoning: "SOUTHERN OAK GIFT → Meals (50% deductible) (reviewed)" },
  { pattern: /paychex\s+taxes/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "PAYCHEX TAXES → Payroll Expenses (reviewed)" },
  { pattern: /paychex\s+flexperks/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "PAYCHEX FLEXPERKS → Payroll Expenses (reviewed)" },
  { pattern: /amazon\s+business/i, account: "Office Supplies", confidence: 0.9, reasoning: "AMAZON BUSINESS → Office Supplies (reviewed)", vendor: "Amazon Business" },
  { pattern: /sgi\s+canada\s+saskatchewan/i, account: "Vehicle Insurance", confidence: 0.9, reasoning: "SGI CANADA SASKATCHEWAN → Vehicle Insurance (reviewed)", vendor: "SGI Canada" },
  { pattern: /adp\s+payroll\s+fees/i, account: "Payroll Expenses", confidence: 0.9, reasoning: "ADP PAYROLL FEES → Payroll Expenses (reviewed)" },

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
  { pattern: /\bfit4less\b/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Fit4Less → Owner Draw (personal)", vendor: "Fit4Less" },
  { pattern: /good\s*life\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "GoodLife Fitness → Owner Draw (personal)" },
  { pattern: /anytime\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Anytime Fitness → Owner Draw (personal)" },
  { pattern: /\bplanet\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Planet Fitness → Owner Draw (personal)" },
  { pattern: /\bworld\s+gym\b/i, account: "Owner's Draw", confidence: 0.95, reasoning: "World Gym → Owner Draw (personal)" },
  { pattern: /\bcrunch\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Crunch Fitness → Owner Draw (personal)" },
  { pattern: /\b(la|24\s*hour)\s+fitness/i, account: "Owner's Draw", confidence: 0.95, reasoning: "LA/24h Fitness → Owner Draw (personal)" },
  { pattern: /\borange\s*theory/i, account: "Owner's Draw", confidence: 0.95, reasoning: "Orangetheory → Owner Draw (personal)", vendor: "Orangetheory" },
  { pattern: /\b(curves|f45|crossfit)\b/i, account: "Owner's Draw", confidence: 0.93, reasoning: "Gym/CrossFit → Owner Draw (personal)" },
  { pattern: /\byoga\s+(studio|barn|works)/i, account: "Owner's Draw", confidence: 0.90, reasoning: "Yoga studio → Owner Draw (personal)" },

  // ══════════════════ GROCERY STORES → Employee Benefits (employee appreciation) ══════════════════
  // Trades clients buying groceries are usually doing it for crew lunches /
  // employee appreciation. Default to Employee Benefits.
  { pattern: /\bfresh[\s\-]?co\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Freshco → Employee Benefits (crew snacks/appreciation)", vendor: "Freshco" },
  { pattern: /save[\s\-]?on[\s\-]?foods/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Save-On-Foods → Employee Benefits", vendor: "Save-On-Foods" },
  { pattern: /\bsobeys\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Sobeys → Employee Benefits", vendor: "Sobeys" },
  { pattern: /\bloblaws?\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Loblaws → Employee Benefits", vendor: "Loblaws" },
  { pattern: /real\s+canadian\s+superstore|\bsuperstore\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Superstore → Employee Benefits", vendor: "Superstore" },
  { pattern: /\biga\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "IGA → Employee Benefits", vendor: "IGA" },
  { pattern: /\bsafeway\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Safeway → Employee Benefits", vendor: "Safeway" },
  { pattern: /\bco[\s\-]?op\s+food/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Co-op Food → Employee Benefits", vendor: "Co-op Food" },
  { pattern: /\bno\s+frills\b/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "No Frills → Employee Benefits", vendor: "No Frills" },
  { pattern: /\bmetro\b\s*(grocer|food)?/i, account: "Employee Benefits – Admin & Sales", confidence: 0.85, reasoning: "Metro grocery → Employee Benefits" },
  { pattern: /\bt\s*&\s*t\s+supermarket|t\&t\s+market/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "T&T Supermarket → Employee Benefits", vendor: "T&T Supermarket" },
  { pattern: /\bfortinos\b|\bzehrs\b|\bvalu[\s\-]?mart/i, account: "Employee Benefits – Admin & Sales", confidence: 0.92, reasoning: "Loblaws-family grocery → Employee Benefits" },

  // ══════════════════ WALMART → Office Supplies ══════════════════
  { pattern: /\bwalmart\b|\bwal[\s\-]?mart\b/i, account: "Office Supplies", confidence: 0.92, reasoning: "Walmart → Office Supplies", vendor: "Walmart" },

  // ══════════════════ COSTCO DISAMBIGUATION (most specific first) ══════════════════
  { pattern: /costco\s*(gas|fuel|cardlock)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Costco Gas → Fuel", vendor: "Costco Gas" },
  { pattern: /costco\s*(food court|restaurant)/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Costco Food Court → Meals" },
  { pattern: /costco\s*(whse|wholesale|business)/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Costco Wholesale → Job Supplies (default for trades)", vendor: "Costco Wholesale" },

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
  { pattern: /\bessom?\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Esso → Fuel", vendor: "Esso" },
  { pattern: /\bshell\b(?!.*lube)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Shell → Fuel", vendor: "Shell" },
  { pattern: /\bchevron\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Chevron → Fuel", vendor: "Chevron" },
  { pattern: /petro[\s\-]?canada/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Petro-Canada → Fuel", vendor: "Petro-Canada" },
  { pattern: /\bpetro[\s\-]?pass\b/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Petro-Pass → Fuel", vendor: "Petro-Pass" },
  { pattern: /\bhusky\b(?!.*travel)/i, account: "Fuel – Overhead", confidence: 0.93, reasoning: "Husky → Fuel", vendor: "Husky" },
  { pattern: /\bhusky\s+travel/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Husky Travel Centre → Fuel", vendor: "Husky Travel Centre" },
  { pattern: /hughes\s+petroleum/i, account: "Fuel – Overhead", confidence: 0.97, reasoning: "Hughes Petroleum → Fuel", vendor: "Hughes Petroleum" },
  { pattern: /\bco[\s\-]?op\s+(gas|cardlock|fuel)/i, account: "Fuel – Overhead", confidence: 0.95, reasoning: "Co-op Gas/Cardlock → Fuel" },
  { pattern: /federated\s+co[\s\-]?op/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Federated Co-op → Fuel (likely)", vendor: "Federated Co-op" },
  { pattern: /\bdomo\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Domo → Fuel", vendor: "Domo" },
  { pattern: /\bfasgas\b/i, account: "Fuel – Overhead", confidence: 0.93, reasoning: "FasGas → Fuel", vendor: "FasGas" },
  { pattern: /\bcentex\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Centex → Fuel", vendor: "Centex" },
  { pattern: /\bmohawk\b/i, account: "Fuel – Overhead", confidence: 0.88, reasoning: "Mohawk → Fuel", vendor: "Mohawk" },
  { pattern: /\bmacewen\b/i, account: "Fuel – Overhead", confidence: 0.90, reasoning: "Macewen → Fuel", vendor: "Macewen" },
  { pattern: /pioneer\s+(gas|station)/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Pioneer Gas → Fuel", vendor: "Pioneer Gas" },
  { pattern: /\b7[\s\-]?eleven\b/i, account: "Fuel – Overhead", confidence: 0.85, reasoning: "7-Eleven → Fuel (convenience+gas)" },
  { pattern: /\bcircle\s*k\b/i, account: "Fuel – Overhead", confidence: 0.85, reasoning: "Circle K → Fuel", vendor: "Circle K" },
  { pattern: /\brace\s*trac\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Race Trac → Fuel", vendor: "Race Trac" },
  { pattern: /\bspeedway\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Speedway → Fuel", vendor: "Speedway" },
  { pattern: /\bsunoco\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Sunoco → Fuel", vendor: "Sunoco" },
  { pattern: /\b(mobil|exxon)\b/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "Mobil/Exxon → Fuel" },
  { pattern: /\bbp\s+(gas|fuel)/i, account: "Fuel – Overhead", confidence: 0.92, reasoning: "BP → Fuel" },

  // ══════════════════ PAINT SUPPLIERS (painters only) ══════════════════
  { pattern: /sherwin[\s\-]?williams|^sw\s+(paint|stores)/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Sherwin-Williams → Job Supplies & Materials", vendor: "Sherwin-Williams", industries: ["painters"] },
  { pattern: /benjamin\s+moore|\bbm\s+paint/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Benjamin Moore → Job Supplies & Materials", vendor: "Benjamin Moore", industries: ["painters"] },
  { pattern: /dunn[\s\-]?edwards/i, account: "Job Supplies & Materials", confidence: 0.97, reasoning: "Dunn-Edwards → Job Supplies & Materials", vendor: "Dunn-Edwards", industries: ["painters"] },
  { pattern: /\bppg\b/i, account: "Job Supplies & Materials", confidence: 0.92, reasoning: "PPG → Job Supplies & Materials", vendor: "PPG", industries: ["painters"] },
  { pattern: /para\s+paint/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Para Paints → Job Supplies & Materials", vendor: "Para Paints", industries: ["painters"] },
  { pattern: /cloverdale\s+paint/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Cloverdale Paint → Job Supplies & Materials", vendor: "Cloverdale Paint", industries: ["painters"] },
  { pattern: /general\s+paint/i, account: "Job Supplies & Materials", confidence: 0.92, reasoning: "General Paint → Job Supplies & Materials", vendor: "General Paint", industries: ["painters"] },
  { pattern: /kelly[\s\-]?moore/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Kelly-Moore → Job Supplies & Materials", vendor: "Kelly-Moore", industries: ["painters"] },
  { pattern: /\bbehr\b/i, account: "Job Supplies & Materials", confidence: 0.90, reasoning: "Behr Paint → Job Supplies & Materials", vendor: "Behr Paint", industries: ["painters"] },

  // ══════════════════ HARDWARE / JOB SUPPLIES ══════════════════
  { pattern: /home\s+depot|\bhd\s+supply/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Home Depot → Job Supplies & Materials", vendor: "Home Depot" },
  { pattern: /\blowes\b|\blowe['']?s\b/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Lowe's → Job Supplies & Materials", vendor: "Lowe's" },
  { pattern: /\brona\b/i, account: "Job Supplies & Materials", confidence: 0.95, reasoning: "Rona → Job Supplies & Materials", vendor: "Rona" },
  { pattern: /canadian\s+tire/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Canadian Tire → Job Supplies (likely)", vendor: "Canadian Tire" },
  { pattern: /\bace\s+hardware/i, account: "Job Supplies & Materials", confidence: 0.93, reasoning: "Ace Hardware → Job Supplies & Materials", vendor: "Ace Hardware" },
  { pattern: /princess\s+auto/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Princess Auto → Job Supplies / Small Tools", vendor: "Princess Auto" },
  { pattern: /\btsc\s+stores|tractor\s+supply/i, account: "Job Supplies & Materials", confidence: 0.90, reasoning: "TSC → Job Supplies & Materials", vendor: "TSC" },
  { pattern: /shoppers\s+drug\s+mart|\bsdm\b/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "Shoppers Drug Mart → Job Supplies (small consumables)", vendor: "Shoppers Drug Mart" },
  { pattern: /london\s+drugs/i, account: "Job Supplies & Materials", confidence: 0.85, reasoning: "London Drugs → Job Supplies & Materials", vendor: "London Drugs" },
  { pattern: /\bwalgreens\b/i, account: "Job Supplies & Materials", confidence: 0.82, reasoning: "Walgreens → Job Supplies (small consumables)", vendor: "Walgreens" },
  { pattern: /\bcvs\b/i, account: "Job Supplies & Materials", confidence: 0.82, reasoning: "CVS → Job Supplies & Materials", vendor: "CVS" },

  // ══════════════════ MEALS — quick-service ══════════════════
  { pattern: /tim\s+hortons?\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Tim Hortons → Meals", vendor: "Tim Hortons" },
  { pattern: /\bmcdonald['']?s\b|\bmcd\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "McDonald's → Meals", vendor: "McDonald's" },
  { pattern: /\bsubway\b(?!.*car)/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Subway → Meals", vendor: "Subway" },
  { pattern: /\bstarbucks\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Starbucks → Meals", vendor: "Starbucks" },
  { pattern: /\ba\s*&\s*w\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "A&W → Meals", vendor: "A&W" },
  { pattern: /dairy\s+queen|\bdq\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Dairy Queen → Meals", vendor: "Dairy Queen" },
  { pattern: /\bwendy['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Wendy's → Meals", vendor: "Wendy's" },
  { pattern: /burger\s+king/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Burger King → Meals", vendor: "Burger King" },
  { pattern: /\bkfc\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "KFC → Meals", vendor: "KFC" },
  { pattern: /\bpopeyes\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Popeyes → Meals", vendor: "Popeyes" },
  { pattern: /taco\s+bell/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Taco Bell → Meals", vendor: "Taco Bell" },
  { pattern: /\bchipotle\b/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Chipotle → Meals", vendor: "Chipotle" },
  { pattern: /five\s+guys/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Five Guys → Meals", vendor: "Five Guys" },
  { pattern: /\bdomino['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Domino's → Meals", vendor: "Domino's" },
  { pattern: /pizza\s+hut/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Pizza Hut → Meals", vendor: "Pizza Hut" },
  { pattern: /\bpanera\b/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Panera → Meals", vendor: "Panera" },
  { pattern: /booster\s+juice|jugo\s+juice|second\s+cup/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Juice/Coffee → Meals" },

  // ══════════════════ MEALS — sit-down ══════════════════
  { pattern: /\bearls?\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Earls → Meals", vendor: "Earls" },
  { pattern: /boston\s+pizza/i, account: "Meals (50% deductible)", confidence: 0.97, reasoning: "Boston Pizza → Meals", vendor: "Boston Pizza" },
  { pattern: /\bjoey['']?s\b/i, account: "Meals (50% deductible)", confidence: 0.92, reasoning: "Joey's → Meals", vendor: "Joey's" },
  { pattern: /cactus\s+club/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Cactus Club → Meals", vendor: "Cactus Club" },
  { pattern: /moxie['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Moxie's → Meals", vendor: "Moxie's" },
  { pattern: /the\s+keg|\bkeg\s+steak/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "The Keg → Meals", vendor: "The Keg" },
  { pattern: /original\s+joe['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Original Joe's → Meals", vendor: "Original Joe's" },
  { pattern: /montana['']?s/i, account: "Meals (50% deductible)", confidence: 0.93, reasoning: "Montana's → Meals", vendor: "Montana's" },
  { pattern: /browns?\s+socialhouse/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Browns Socialhouse → Meals", vendor: "Browns Socialhouse" },
  { pattern: /\bdenny['']?s\b|\bihop\b|smitty['']?s|kelsey['']?s/i, account: "Meals (50% deductible)", confidence: 0.95, reasoning: "Family restaurant chain → Meals", vendor: "Family restaurant chain" },

  // ══════════════════ VEHICLE REPAIRS ══════════════════
  { pattern: /mr\.?\s+lube|jiffy\s+lube/i, account: "Vehicle Repairs", confidence: 0.97, reasoning: "Lube shop → Vehicle Repairs" },
  { pattern: /mister\s+transmission/i, account: "Vehicle Repairs", confidence: 0.97, reasoning: "Mister Transmission → Vehicle Repairs", vendor: "Mister Transmission" },
  { pattern: /\bmidas\b/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Midas → Vehicle Repairs", vendor: "Midas" },
  { pattern: /kal\s+tire|fountain\s+tire|ok\s+tire/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Tire shop → Vehicle Repairs" },
  { pattern: /canadian\s+tire\s+(auto|car)/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Canadian Tire Auto → Vehicle Repairs", vendor: "Canadian Tire Auto" },
  { pattern: /pep\s+boys/i, account: "Vehicle Repairs", confidence: 0.95, reasoning: "Pep Boys → Vehicle Repairs", vendor: "Pep Boys" },
  { pattern: /\bautozone\b/i, account: "Vehicle Repairs", confidence: 0.90, reasoning: "AutoZone → Vehicle Repairs", vendor: "AutoZone" },

  // ══════════════════ JOB DISPOSAL ══════════════════
  { pattern: /waste\s+management|\bwm\s+(canada|inc)/i, account: "Job Disposal Fees", confidence: 0.95, reasoning: "Waste Management → Job Disposal Fees", vendor: "Waste Management" },
  { pattern: /edmonton\s+waste/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "Edmonton Waste → Job Disposal Fees", vendor: "Edmonton Waste" },
  { pattern: /\bbfi\b|republic\s+services/i, account: "Job Disposal Fees", confidence: 0.95, reasoning: "BFI/Republic → Job Disposal Fees" },
  { pattern: /gfl\s+environmental/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "GFL → Job Disposal Fees", vendor: "GFL" },
  { pattern: /\bbagster\b|\bgot\s+junk\b|1[\s\-]?800[\s\-]?got[\s\-]?junk/i, account: "Job Disposal Fees", confidence: 0.97, reasoning: "Junk removal → Job Disposal Fees", vendor: "Junk removal" },
  { pattern: /\bdump\s+(fee|station)|transfer\s+station/i, account: "Job Disposal Fees", confidence: 0.93, reasoning: "Dump/Transfer station → Job Disposal Fees" },

  // ══════════════════ BANK CHARGES ══════════════════
  { pattern: /\bnsf\s+fee|nsf\s+charge/i, account: "Bank Charges", confidence: 0.99, reasoning: "NSF Fee → Bank Charges" },
  { pattern: /overdraft\s+fee/i, account: "Bank Charges", confidence: 0.99, reasoning: "Overdraft Fee → Bank Charges" },
  { pattern: /bank\s+service\s+charge|monthly\s+plan\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Bank Service Charge → Bank Charges" },
  { pattern: /stop\s+payment\s+fee|wire\s+fee|wire\s+transfer\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Wire/Stop-payment fee → Bank Charges" },
  { pattern: /interac\s+e[\s\-]?transfer\s+fee|e[\s\-]?tfr\s+fee|emt\s+fee/i, account: "Bank Charges", confidence: 0.97, reasoning: "Interac e-Transfer Fee → Bank Charges" },

  // ══════════════════ INSURANCE ══════════════════
  { pattern: /state\s+farm/i, account: "Insurance – Other", confidence: 0.85, reasoning: "State Farm → Insurance", vendor: "State Farm" },
  { pattern: /\ballstate\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Allstate → Insurance", vendor: "Allstate" },
  { pattern: /\bgeico\b/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Geico → Insurance", vendor: "Geico" },
  { pattern: /progressive\s+(ins|claim)/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Progressive → Insurance", vendor: "Progressive" },
  { pattern: /\bintact\b|\baviva\b|wawanesa|co[\s\-]?operators/i, account: "Insurance – Other", confidence: 0.85, reasoning: "Canadian insurer → Insurance" },
  { pattern: /\bwsib\b|\bwcb\b/i, account: "Workers Compensation – Admin", confidence: 0.93, reasoning: "WSIB/WCB → Workers Comp" },
  { pattern: /blue\s+cross/i, account: "Health Insurance – Owner", confidence: 0.90, reasoning: "Blue Cross → Health Insurance", vendor: "Blue Cross" },

  // ══════════════════ ADVERTISING ══════════════════
  // Real bank feeds don't say "Google Ads" — they say GOOGLE*ADS4739, GOOGLEADS,
  // FACEBK *X2A7B9, FB *ADVERTISING. Cover the descriptor forms explicitly
  // (bookkeeper feedback: these were falling through to AI and landing in
  // Software Subscriptions).
  { pattern: /google\s*\*?\s*ads\w*|googleads|google\s+adwords/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "Google Ads → Online Advertising", vendor: "Google Ads" },
  { pattern: /\bfacebk\b|\bfb\s*\*|\bmeta\s+(ads|platforms?)\b|facebook\s*ads|instagr?am\s*ads/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "Meta/Facebook descriptor → Online Advertising" },
  { pattern: /linkedin\s+ads|tiktok\s+ads|snapchat\s+ads/i, account: "Online Advertising - Ad Spend", confidence: 0.97, reasoning: "Social ads → Online Advertising" },
  { pattern: /yelp\s+ads|\bangi\b|home\s*advisor|\bhouzz\b/i, account: "Online Advertising - Ad Spend", confidence: 0.93, reasoning: "Lead-gen platform → Online Advertising", vendor: "Lead-gen platform" },

  // ══════════════════ SOFTWARE ══════════════════
  { pattern: /quickbooks|\bintuit\b/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "QuickBooks/Intuit → Software" },
  { pattern: /\bxero\b/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "Xero → Software", vendor: "Xero" },
  { pattern: /microsoft|office\s+365|\bms365\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Microsoft → Software", vendor: "Microsoft" },
  { pattern: /google\s*\*?\s*(workspace|suite|gsuite)/i, account: "Software Subscriptions", confidence: 0.97, reasoning: "Google Workspace → Software", vendor: "Google Workspace" },
  { pattern: /\badobe\b/i, account: "Software Subscriptions", confidence: 0.93, reasoning: "Adobe → Software", vendor: "Adobe" },
  { pattern: /\bdropbox\b|\bslack\b|\bzoom\b|\bnotion\b/i, account: "Software Subscriptions", confidence: 0.95, reasoning: "Tech subscription → Software" },
  { pattern: /apple\.com|apple\s+(icloud|services)/i, account: "Software Subscriptions", confidence: 0.90, reasoning: "Apple iCloud → Software", vendor: "Apple iCloud" },
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
  { pattern: /\bhilton\b|\bmarriott\b|holiday\s+inn|hampton\s+inn|sheraton|\bhyatt\b|comfort\s+inn|best\s+western/i, account: "Travel – Airfare & Lodging", confidence: 0.97, reasoning: "Hotel chain → Travel", vendor: "Hotel chain" },
  { pattern: /\bexpedia\b|booking\.com|\bairbnb\b|\bkayak\b/i, account: "Travel – Airfare & Lodging", confidence: 0.95, reasoning: "Travel platform → Travel" },

  // ══════════════════ OFFICE SUPPLIES ══════════════════
  { pattern: /\bstaples\b/i, account: "Office Supplies", confidence: 0.95, reasoning: "Staples → Office Supplies", vendor: "Staples" },
  { pattern: /office\s+depot/i, account: "Office Supplies", confidence: 0.95, reasoning: "Office Depot → Office Supplies", vendor: "Office Depot" },

  // ══════════════════ POSTAGE & DELIVERY ══════════════════
  { pattern: /canada\s+post|\busps\b|\bups\s+store|\bfedex\b|\bdhl\b|purolator/i, account: "Postage & Delivery", confidence: 0.95, reasoning: "Shipping → Postage & Delivery" },

  // ══════════════════ ACCOUNTING / LEGAL ══════════════════
  { pattern: /\bcpa\b|chartered\s+(prof|account)|\bca\s+firm|tax\s+(service|prep)|h&r\s+block/i, account: "Accounting & Bookkeeping", confidence: 0.90, reasoning: "Accountant → Accounting & Bookkeeping" },
  { pattern: /\battorney|\blaw\s+(firm|office)|\blegal\s+services|\bllp\b/i, account: "Legal Fees", confidence: 0.85, reasoning: "Legal services → Legal Fees", vendor: "Legal services" },

  // ══════════════════ BARE GOOGLE / FACEBOOK FALLBACKS (keep LAST: every specific form above wins first) ══════════════════
  // For a trades contractor, a bare GOOGLE or FACEBOOK charge is almost always
  // advertising, not software. Confidence sits below the auto-execute floor so
  // these queue for a human instead of posting; the lookaheads keep consumer
  // Google products (One/Play/YouTube/Fi/etc.) out of the net.
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
