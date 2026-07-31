/**
 * Is the same person being paid as an employee AND as a subcontractor?
 *
 * WHY THIS EXISTS. RocketPainter Kingston pays nine people through QBO Payroll
 * and pays Paul Benia, Jim Blakely and Tigh Gallagher as subcontractors. Those
 * are different people, which is fine. But Jennifer Harvey is on payroll AND
 * has $1,665 in Subcontractors, $146 in Subcontractors – Painting, and $1,813
 * of bare e-transfers inside Direct Field Labor. Nothing in SNAP noticed.
 *
 * That matters for two reasons that have nothing to do with the P&L totals:
 *
 *   1. Worker classification. One person on both paths is a CRA/IRS question,
 *      and it means a T4 and a T5018 (or W-2 and 1099) for the same individual.
 *   2. Unrecorded wages. A bare e-transfer to someone on payroll is either a
 *      reimbursement or extra pay, and only the client knows which.
 *
 * DESIGN: NEVER AUTO-FIX. Every finding here is a question for the client, not
 * a reclass. Two people genuinely share a name; a company is sometimes named
 * after its owner; a fuel reimbursement looks exactly like a small wage top-up.
 * So this produces flags with the underlying transactions attached as evidence,
 * routed to the ask-client flow, and every one is dismissible.
 *
 * Pure — the caller passes P&L detail rows it already has.
 */

/** One posting from the period's P&L detail. */
export interface WorkerScanRow {
  account: string;
  txn_type: string;
  name: string | null;
  memo: string | null;
  amount: number;
  date?: string;
}

/**
 * Optional identity records from QBO's Employee and Vendor lists. An exact
 * email or phone match between an employee and a vendor is near-proof and is
 * immune to name spelling, which is why it is tier 1. Populating this needs two
 * QBO entity fetchers that don't exist yet, so it is OPTIONAL — tiers 2 and 3
 * work from the P&L detail alone.
 */
export interface QboIdentity {
  kind: "employee" | "vendor";
  name: string;
  email?: string | null;
  phone?: string | null;
}

export type OverlapTier =
  /** Same identity on both paths in this period — the classification question. */
  | "both_paths"
  /** On subs now, on payroll earlier — moved employee → contractor. */
  | "moved_to_contractor"
  /** On payroll and receiving non-payroll payments — reimbursement or wages? */
  | "payroll_employee_other_pay";

export interface OverlapFinding {
  tier: OverlapTier;
  person: string;
  /** How we tied the two sides together, so a reviewer can judge it. */
  matchedOn: "email" | "phone" | "name" | "memo";
  /** Total on the non-payroll side. */
  amount: number;
  accounts: string[];
  postings: Array<{ date: string; account: string; txn_type: string; amount: number; memo: string }>;
  question: string;
}

export interface OverlapResult {
  employeeCount: number;
  findings: OverlapFinding[];
  /** Total non-payroll dollars paid to people who are also on payroll. */
  exposure: number;
  summary: string;
}

const PAYCHEQUE_TXN = /paycheque|paycheck|pay check|payroll check/i;
/** Subcontractor-ish account names. Local to this file on purpose — it is a
 *  different question from "which accounts might hold duplicated payroll". */
const SUBCONTRACTOR_ACCOUNT = /\b(subcontract\w*|contractors?|contract\s+labou?r|1099)\b/i;
/** A payment whose memo names a non-wage purpose is a reimbursement. Same
 *  exclusion the payroll double-count detector uses, for the same reason. */
const REIMBURSEMENT_MEMO = /\b(reimburs\w*|repa(?:id|yment)|expense\s*report|mileage|per\s*diem)\b/i;
/** Below this, a match is noise not exposure. */
const MIN_AMOUNT = 50;

/** Normalise a person's name for comparison: case, punctuation, QBO's "(2)"
 *  dedup suffix, and `Last, First` → `first last`. */
export function normalizePerson(raw: string | null | undefined): string {
  let s = (raw || "").toLowerCase().trim();
  if (!s) return "";
  s = s.replace(/\s*\(\d+\)\s*$/, "");
  if (s.includes(",")) {
    const [last, first] = s.split(",", 2);
    s = `${(first || "").trim()} ${(last || "").trim()}`;
  }
  return s.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Do two names plausibly refer to one person? Exact after normalisation, or
 * same surname with a first-initial match ("j blakely" ≈ "jim blakely").
 *
 * Deliberately NOT fuzzy beyond that. Levenshtein on human names generates
 * confident nonsense, and this feeds a conversation with a client about tax
 * filings — a false positive there costs more than a miss.
 */
export function samePerson(a: string, b: string): boolean {
  const x = normalizePerson(a);
  const y = normalizePerson(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(" ");
  const ys = y.split(" ");
  if (xs.length < 2 || ys.length < 2) return false;
  if (xs[xs.length - 1] !== ys[ys.length - 1]) return false; // surnames must match
  const xf = xs[0];
  const yf = ys[0];
  return (xf.length === 1 && yf.startsWith(xf)) || (yf.length === 1 && xf.startsWith(yf));
}

function digits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

export function detectWorkerOverlap(
  rows: WorkerScanRow[],
  identities: QboIdentity[] = []
): OverlapResult {
  // ── The payroll roster: who QBO Payroll actually pays ────────────────────
  const employees = new Set<string>();
  for (const r of rows || []) {
    if (PAYCHEQUE_TXN.test(r.txn_type) && r.name) {
      const p = normalizePerson(r.name);
      if (p) employees.add(p);
    }
  }

  const findings: OverlapFinding[] = [];
  if (employees.size === 0) {
    return {
      employeeCount: 0,
      findings,
      exposure: 0,
      // Said explicitly: no roster means this check could not run, which is a
      // different statement from "nothing found".
      summary: "No QBO Payroll paycheques this period — no roster to compare against",
    };
  }

  // ── Tier 1: shared email / phone between an Employee and a Vendor ────────
  const tier1 = new Map<string, "email" | "phone">();
  const emps = identities.filter((i) => i.kind === "employee");
  const vends = identities.filter((i) => i.kind === "vendor");
  for (const e of emps) {
    for (const v of vends) {
      const em = (e.email || "").toLowerCase().trim();
      const vm = (v.email || "").toLowerCase().trim();
      if (em && em === vm) {
        tier1.set(normalizePerson(v.name), "email");
        continue;
      }
      const ep = digits(e.phone);
      const vp = digits(v.phone);
      if (ep.length >= 10 && ep === vp) tier1.set(normalizePerson(v.name), "phone");
    }
  }

  // ── Group every NON-paycheque posting by the person it names ─────────────
  type Bucket = {
    person: string;
    matchedOn: OverlapFinding["matchedOn"];
    amount: number;
    accounts: Set<string>;
    postings: OverlapFinding["postings"];
    onSubAccount: boolean;
  };
  const buckets = new Map<string, Bucket>();

  const addTo = (
    person: string,
    matchedOn: OverlapFinding["matchedOn"],
    r: WorkerScanRow
  ) => {
    const b =
      buckets.get(person) ||
      ({ person, matchedOn, amount: 0, accounts: new Set<string>(), postings: [], onSubAccount: false } as Bucket);
    // A stronger match wins: email/phone beat a name, a name beats a memo.
    const rank = { email: 3, phone: 3, name: 2, memo: 1 } as const;
    if (rank[matchedOn] > rank[b.matchedOn]) b.matchedOn = matchedOn;
    b.amount = Math.round((b.amount + Math.abs(r.amount)) * 100) / 100;
    b.accounts.add(r.account);
    if (SUBCONTRACTOR_ACCOUNT.test(r.account)) b.onSubAccount = true;
    b.postings.push({
      date: r.date || "",
      account: r.account,
      txn_type: r.txn_type,
      amount: Math.abs(r.amount),
      memo: (r.memo || "").slice(0, 60),
    });
    buckets.set(person, b);
  };

  for (const r of rows || []) {
    if (PAYCHEQUE_TXN.test(r.txn_type)) continue; // the legitimate wage record
    const blob = `${r.name || ""} ${r.memo || ""}`;
    if (REIMBURSEMENT_MEMO.test(blob)) continue; // stated purpose, not wages

    const named = normalizePerson(r.name);

    // tier 1 — identity
    if (named && tier1.has(named)) {
      addTo(named, tier1.get(named)!, r);
      continue;
    }
    // tier 2 — the payee is on the payroll roster
    if (named) {
      const hit = [...employees].find((e) => samePerson(e, named));
      if (hit) {
        addTo(hit, "name", r);
        continue;
      }
    }
    // tier 3 — no payee, but the bank memo names someone on the roster. This is
    // the RocketPainter case: "E-TRANSFERXXXXXXXX6926 Jennifer Harvey".
    if (r.memo) {
      const memo = normalizePerson(r.memo);
      const hit = [...employees].find((e) => memo.includes(e));
      if (hit) addTo(hit, "memo", r);
    }
  }

  // ── Turn buckets into tiered findings ───────────────────────────────────
  for (const b of buckets.values()) {
    if (b.amount < MIN_AMOUNT) continue;
    const accounts = [...b.accounts];
    const display = titleCase(b.person);

    const tier: OverlapTier = b.onSubAccount ? "both_paths" : "payroll_employee_other_pay";
    const question =
      tier === "both_paths"
        ? `${display} is paid through payroll AND booked to ${accounts.filter((a) => SUBCONTRACTOR_ACCOUNT.test(a)).join(", ") || "a subcontractor account"} ` +
          `(${money(b.amount)}). If that is the same person, they cannot be both an employee and a subcontractor for the same work — ` +
          `it changes which slips get filed. Confirm with the client which one is correct.`
        : `${display} is on payroll and also received ${money(b.amount)} of non-payroll payments ` +
          `(${accounts.join(", ")}). Ask the client whether these were expense reimbursements or additional pay — ` +
          `if it is pay, it belongs on a paycheque so the withholdings are right.`;

    findings.push({
      tier,
      person: display,
      matchedOn: b.matchedOn,
      amount: b.amount,
      accounts,
      postings: b.postings.sort((x, y) => x.date.localeCompare(y.date)),
      question,
    });
  }

  findings.sort((a, b) => b.amount - a.amount);
  const exposure = Math.round(findings.reduce((s, f) => s + f.amount, 0) * 100) / 100;
  const bothPaths = findings.filter((f) => f.tier === "both_paths").length;

  const summary =
    findings.length === 0
      ? `${employees.size} payroll employee${employees.size === 1 ? "" : "s"}, none paid outside payroll`
      : `${findings.length} of ${employees.size} payroll employee${employees.size === 1 ? "" : "s"} also paid outside payroll ` +
        `(${money(exposure)})` +
        (bothPaths ? ` — ${bothPaths} on a subcontractor account` : "");

  return { employeeCount: employees.size, findings, exposure, summary };
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function money(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
