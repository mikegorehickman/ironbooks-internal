import type { QBOAccount } from "@/lib/qbo";

/**
 * Statement-request enumeration — the three-way account reconciliation.
 * ─────────────────────────────────────────────────────────────────────
 * Replaces the generic "credit card statements + a few open invoices" ask
 * with one named request line per account (Mike/JP, 2026-07-10 call:
 * "pulling all of the bank accounts it can identify in QuickBooks and
 * requesting statements from every single account individually… plus loan
 * statements and the CRM job report").
 *
 * Three sources, reconciled:
 *   1. QBO chart of accounts (Account LIST api — includes zero-balance
 *      accounts the Balance Sheet report hides; Dominion's 4th account)
 *   2. Bank-feed evidence (accounts seen on is_bank_fed reclass lines;
 *      earliest such date ≈ feed-connection date — QBO has no public feeds
 *      API, this proxy is the best available)
 *   3. Client-declared accounts from onboarding (attestation)
 *
 * Every diff auto-generates the right artifact: declared-but-missing → a
 * create-account card (and the request line is issued anyway);
 * in-books-but-undeclared → an ask_client ("business or personal?" — this IS
 * the personal-card detector, with ground truth); declared loan → its own
 * loan-statement line. All three agree → silent request lines, zero touches.
 *
 * Pure functions — QBO/DB fetching lives in the route.
 */

export interface FeedEvidence {
  /** normalized bank_account_name → earliest bank-fed txn date (YYYY-MM-DD) */
  firstSeenByAccount: Map<string, string>;
}

export interface DeclaredAccount {
  /** free-text from onboarding: "RBC chequing", "Visa ending 7053", "F-150 loan" */
  name: string;
  kind: "bank" | "credit_card" | "loan" | "unknown";
}

export interface EnumeratedAccount {
  label: string;                       // "RBC Chequing ****7053"
  kind: "bank" | "credit_card" | "loan";
  qbo_account_id: string | null;       // null = declared but not in QBO yet
  qbo_account_name: string | null;
  last4: string | null;
  feed_first_date: string | null;      // inferred feed-connection date
  sources: Array<"qbo_coa" | "bank_feed" | "onboarding">;
}

export interface RequestLine {
  label: string;
  account_name: string | null;
  account_kind: string;
  qbo_account_id: string | null;
  period_start: string | null;
  period_end: string | null;
  source: string;
}

export interface EnumerationResult {
  accounts: EnumeratedAccount[];
  requests: RequestLine[];
  /** in QBO/feeds but NOT declared → confirm with client (personal-card net) */
  undeclared_asks: Array<{ label: string; qbo_account_id: string | null }>;
  /** declared but nowhere in QBO → bookkeeper create-account cards */
  missing_from_qbo: Array<{ name: string; kind: string }>;
}

const LOAN_NAME_RE = /loan|note.?payable|line of credit|\bloc\b|financ|mortgage/i;

const normName = (s: string | null | undefined) =>
  (s || "").toLowerCase().replace(/[–—−]/g, "-").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// A masked-account pattern: digits that clearly identify an account — after a
// mask (****1234, x1234), a hash/no., or the words ending/acct/account. We
// only trust digits that look like a mask so we never grab an arbitrary
// number (phone, address) out of a Description and mislabel the account — a
// WRONG last-4 is worse than none (Mike: "or else it's just noise").
const MASK_RE = /(?:\*{2,}|x{2,}|#|\b(?:ending|acct|account|no)\b\.?)\s*[-*# ]*(\d{4})\b/i;

/** Last 4 digits from AcctNum, trailing digits in the name, or a masked
 * pattern in the name/description. Null when nothing reliable is found. */
export function last4Of(a: { Name?: string; AcctNum?: string; Description?: string }): string | null {
  const num = (a.AcctNum || "").replace(/\D/g, "");
  if (num.length >= 3) return num.slice(-4);
  const inName = (a.Name || "").match(/(\d{3,})\D*$/);
  if (inName) return inName[1].slice(-4);
  const masked = (a.Name || "").match(MASK_RE) || (a.Description || "").match(MASK_RE);
  return masked ? masked[1] : null;
}

export function maskedLabel(a: { Name: string; AcctNum?: string; Description?: string }): string {
  const l4 = last4Of(a);
  if (!l4) return a.Name;
  // avoid double-masking names that already show the digits
  return a.Name.replace(/\d{3,}/g, "").replace(/[\s\-*#()]+$/, "").trim() + ` ****${l4}`;
}

/** Loose match between a declared free-text account and a QBO account/feed name. */
export function declaredMatches(declared: string, candidate: string): boolean {
  const d = normName(declared), c = normName(candidate);
  if (!d || !c) return false;
  if (c.includes(d) || d.includes(c)) return true;
  const dTokens = d.split(" ").filter((t) => t.length >= 3 && !["account", "card", "credit", "bank", "the"].includes(t));
  if (dTokens.length === 0) return false;
  const hits = dTokens.filter((t) => c.includes(t)).length;
  const dDigits = declared.replace(/\D/g, "").slice(-4);
  const cDigits = candidate.replace(/\D/g, "").slice(-4);
  if (dDigits.length === 4 && dDigits === cDigits) return true;
  return hits >= Math.max(1, Math.ceil(dTokens.length / 2));
}

export function enumerateAccounts(
  qboAccounts: QBOAccount[],
  feed: FeedEvidence,
  declared: DeclaredAccount[]
): EnumerationResult["accounts"] & any {
  const accounts: EnumeratedAccount[] = [];
  const usedDeclared = new Set<number>();

  const kindOf = (a: QBOAccount): "bank" | "credit_card" | "loan" | null => {
    if (a.AccountType === "Bank") return "bank";
    if (a.AccountType === "Credit Card") return "credit_card";
    if (
      ["Long Term Liability", "Other Current Liability"].includes(a.AccountType) &&
      LOAN_NAME_RE.test(a.Name)
    ) return "loan";
    return null;
  };

  for (const a of qboAccounts) {
    if (a.Active === false) continue;
    const kind = kindOf(a);
    if (!kind) continue;
    const sources: EnumeratedAccount["sources"] = ["qbo_coa"];
    // feed evidence match (bank_account_name from reclass lines is the QBO name)
    let feedDate: string | null = null;
    for (const [name, date] of feed.firstSeenByAccount) {
      if (normName(name) === normName(a.Name) || normName(name) === normName(a.FullyQualifiedName)) {
        feedDate = date;
        sources.push("bank_feed");
        break;
      }
    }
    declared.forEach((d, i) => {
      if (!usedDeclared.has(i) && declaredMatches(d.name, a.Name)) {
        usedDeclared.add(i);
        if (!sources.includes("onboarding")) sources.push("onboarding");
      }
    });
    accounts.push({
      label: maskedLabel(a),
      kind,
      qbo_account_id: a.Id,
      qbo_account_name: a.Name,
      last4: last4Of(a),
      feed_first_date: feedDate,
      sources,
    });
  }

  // declared accounts that matched nothing in QBO
  const missing: EnumerationResult["missing_from_qbo"] = [];
  declared.forEach((d, i) => {
    if (usedDeclared.has(i)) return;
    missing.push({ name: d.name, kind: d.kind });
    accounts.push({
      label: d.name,
      kind: d.kind === "unknown" ? "bank" : d.kind,
      qbo_account_id: null,
      qbo_account_name: null,
      last4: (d.name.replace(/\D/g, "").slice(-4) || null) as string | null,
      feed_first_date: null,
      sources: ["onboarding"],
    });
  });

  return Object.assign(accounts, { missing });
}

const fmtMonth = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Build the full request set. booksStart: last-filed year-end + 1 day when
 * known; otherwise 6 months back (Mike's fallback rule, 2026-07-13).
 */
export function buildRequests(
  accounts: EnumeratedAccount[],
  opts: { booksStart: string; today: string; hasDeclarations?: boolean }
): { requests: RequestLine[]; undeclared_asks: EnumerationResult["undeclared_asks"] } {
  const requests: RequestLine[] = [];
  const asks: EnumerationResult["undeclared_asks"] = [];
  // The "in books but not declared → business or personal?" ask is the
  // personal-card detector, and it only means anything when the client
  // actually declared some accounts at onboarding (a baseline to compare
  // against). With zero declarations EVERY account reads as "undeclared,"
  // which floods the request list with a redundant question per account
  // (e.g. asking whether the operating "Main Account" is personal). Suppress
  // the asks entirely in that case — the statement request per account still
  // goes out.
  const canDetectUndeclared = opts.hasDeclarations === true;

  for (const a of accounts) {
    const base = { account_name: a.qbo_account_name, qbo_account_id: a.qbo_account_id };
    if (a.kind === "loan") {
      requests.push({
        ...base,
        label: `${a.label} — loan statement(s) ${fmtMonth(opts.booksStart)}–${fmtMonth(opts.today)} showing the principal & interest split`,
        account_kind: "loan",
        period_start: opts.booksStart,
        period_end: opts.today,
        source: a.sources.includes("qbo_coa") ? "qbo_coa" : "onboarding",
      });
      continue;
    }
    // Historical gap: books-start → feed-connection date needs CSV/statements
    // (feeds only backfill ~90 days). Feed date unknown → request whole range.
    const gapEnd = a.feed_first_date && a.feed_first_date > opts.booksStart ? a.feed_first_date : null;
    if (gapEnd) {
      requests.push({
        ...base,
        label: `${a.label} — CSV export or statements ${fmtMonth(opts.booksStart)}–${fmtMonth(gapEnd)} (before your bank connected to QuickBooks)`,
        account_kind: a.kind,
        period_start: opts.booksStart,
        period_end: gapEnd,
        source: "gap_csv",
      });
      requests.push({
        ...base,
        label: `${a.label} — monthly statements ${fmtMonth(gapEnd)}–${fmtMonth(opts.today)}`,
        account_kind: a.kind,
        period_start: gapEnd,
        period_end: opts.today,
        source: a.sources.join("+"),
      });
    } else {
      requests.push({
        ...base,
        label: `${a.label} — monthly statements ${fmtMonth(opts.booksStart)}–${fmtMonth(opts.today)}`,
        account_kind: a.kind,
        period_start: opts.booksStart,
        period_end: opts.today,
        source: a.sources.join("+"),
      });
    }
    // in books but the client never declared it → confirm business vs personal
    // (only when there IS a declared baseline — see canDetectUndeclared above)
    if (canDetectUndeclared && !a.sources.includes("onboarding") && a.qbo_account_id) {
      asks.push({ label: a.label, qbo_account_id: a.qbo_account_id });
    }
  }

  // Standing items JP confirmed were right
  requests.push({
    label: "CRM job / payment report (completed jobs with amounts collected)",
    account_name: null, account_kind: "crm_report", qbo_account_id: null,
    period_start: opts.booksStart, period_end: opts.today, source: "standing",
  });
  requests.push({
    label: "List of currently open (unpaid) customer invoices",
    account_name: null, account_kind: "open_invoices", qbo_account_id: null,
    period_start: null, period_end: null, source: "standing",
  });

  return { requests, undeclared_asks: asks };
}
