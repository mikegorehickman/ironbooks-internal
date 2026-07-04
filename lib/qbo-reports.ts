/**
 * QBO Reports API — fetch and parse P&L and account data for tax audit.
 *
 * QBO report responses are deeply nested. We use a recursive flattener to
 * build a label→value map, then look up keys by common name variants.
 */

import { isDemoRealm, demoProfitAndLoss } from "./demo-data";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

async function fetchQBOReport(
  realmId: string,
  accessToken: string,
  reportName: string,
  params: Record<string, string>
): Promise<any> {
  const qs = new URLSearchParams({ ...params, minorversion: "65" });
  const url = `${QBO_BASE}/v3/company/${realmId}/reports/${reportName}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO ${reportName} report failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ─── P&L Drill-down (transactions for a single account) ────────────────

export interface PLDetailTransaction {
  txn_id: string;
  txn_type: string;
  date: string;
  doc_number: string | null;
  /** Vendor for expense accounts, customer for income accounts. */
  name: string | null;
  memo: string;
  /** Signed amount as it appears on the P&L (positive = increases the line). */
  amount: number;
  /** QBO running balance for this account at this row, if the report returns it. */
  running_balance: number | null;
}

/**
 * QBO's ProfitAndLossDetail report — the canonical drill-down for a P&L
 * line. Returns one row per posting line that hit the requested account
 * in the date window. Unlike TransactionList (which is bank/CC-focused
 * and can return weird sums for income/expense accounts), this report
 * matches the P&L line totals exactly.
 *
 * Filter syntax: `account=<id>` accepts a single id or a comma list.
 */
export async function fetchProfitAndLossDetail(
  realmId: string,
  accessToken: string,
  accountId: string,
  startDate: string,
  endDate: string
): Promise<PLDetailTransaction[]> {
  let data: any;
  try {
    data = await fetchQBOReport(realmId, accessToken, "ProfitAndLossDetail", {
      start_date: startDate,
      end_date: endDate,
      // Cash to match the statements and portal P&L (IronBooks is cash-basis) —
      // the drill-down must sum to the line it drills into.
      accounting_method: "Cash",
      account: accountId,
    });
  } catch (err: any) {
    console.warn(`[qbo-reports] ProfitAndLossDetail failed:`, err.message);
    return [];
  }

  // Build a column-name → index map. QBO returns the columns in a fixed
  // shape but order can shift, so always look them up by name.
  const cols: any[] = data?.Columns?.Column || [];
  const colIndex = new Map<string, number>();
  cols.forEach((c, i) => {
    if (c?.ColType) colIndex.set(String(c.ColType).toLowerCase(), i);
    if (c?.ColTitle) colIndex.set(String(c.ColTitle).toLowerCase(), i);
  });
  const ci = (...names: string[]): number | undefined => {
    for (const n of names) {
      const i = colIndex.get(n.toLowerCase());
      if (i !== undefined) return i;
    }
    return undefined;
  };

  const idxDate = ci("tx_date", "date");
  const idxType = ci("txn_type", "transaction type");
  const idxNum = ci("doc_num", "num");
  const idxName = ci("name");
  const idxMemo = ci("memo", "memo/description");
  const idxAmt = ci("subt_nat_amount", "amount", "subt_nat_home_amount");
  const idxBalance = ci("rbal_nat_amount", "balance", "rbal_nat_home_amount");

  const out: PLDetailTransaction[] = [];

  function parseNum(raw: any): number | null {
    if (raw == null || raw === "") return null;
    const cleaned = String(raw).replace(/[,$ ]/g, "");
    // QBO sometimes wraps negatives in parens: "(1,200.00)"
    const parenMatch = cleaned.match(/^\((.+)\)$/);
    const final = parenMatch ? "-" + parenMatch[1] : cleaned;
    const n = Number(final);
    return Number.isFinite(n) ? n : null;
  }

  function walk(node: any) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node.type === "Data" && Array.isArray(node.ColData)) {
      const cd = node.ColData;
      const idCol = cd.find((c: any) => c?.id);
      const get = (i: number | undefined) => (i != null ? cd[i]?.value ?? "" : "");
      const amount = parseNum(get(idxAmt));
      if (amount == null) return; // skip section subtotal rows

      out.push({
        txn_id: idCol?.id ? String(idCol.id) : "",
        txn_type: String(get(idxType) || ""),
        date: String(get(idxDate) || ""),
        doc_number: get(idxNum) ? String(get(idxNum)) : null,
        name: get(idxName) ? String(get(idxName)) : null,
        memo: String(get(idxMemo) || ""),
        amount,
        running_balance: parseNum(get(idxBalance)),
      });
    }
    if (node.Row) walk(node.Row);
    if (node.Rows) walk(node.Rows);
  }
  walk(data?.Rows);

  return out;
}

// ─── Whole-P&L transaction detail (all accounts, with account context) ──────

export interface PLDetailRow extends PLDetailTransaction {
  /** The P&L account this posting line hit (section header in the report). */
  account: string;
  /** Top-level section: Income / Cost of Goods Sold / Expenses / Other … */
  section: string;
}

/**
 * ProfitAndLossDetail for the ENTIRE P&L (no account filter) — one row per
 * posting line in the window, tagged with its account + top-level section.
 * Used by the duplicate-transaction scan. Basis selectable (statements are
 * cash, so dup-scans default to Cash upstream).
 */
export async function fetchPLDetailAll(
  realmId: string,
  accessToken: string,
  startDate: string,
  endDate: string,
  method: "Accrual" | "Cash" = "Cash"
): Promise<PLDetailRow[]> {
  const data = await fetchQBOReport(realmId, accessToken, "ProfitAndLossDetail", {
    start_date: startDate,
    end_date: endDate,
    accounting_method: method,
  });

  const cols: any[] = data?.Columns?.Column || [];
  const colIndex = new Map<string, number>();
  cols.forEach((c, i) => {
    if (c?.ColType) colIndex.set(String(c.ColType).toLowerCase(), i);
    if (c?.ColTitle) colIndex.set(String(c.ColTitle).toLowerCase(), i);
  });
  const ci = (...names: string[]): number | undefined => {
    for (const n of names) {
      const i = colIndex.get(n.toLowerCase());
      if (i !== undefined) return i;
    }
    return undefined;
  };
  const idxDate = ci("tx_date", "date");
  const idxType = ci("txn_type", "transaction type");
  const idxNum = ci("doc_num", "num");
  const idxName = ci("name");
  const idxMemo = ci("memo", "memo/description");
  const idxAmt = ci("subt_nat_amount", "amount", "subt_nat_home_amount");

  const parseNum = (raw: any): number | null => {
    if (raw == null || raw === "") return null;
    const cleaned = String(raw).replace(/[,$ ]/g, "");
    const parenMatch = cleaned.match(/^\((.+)\)$/);
    const n = Number(parenMatch ? "-" + parenMatch[1] : cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const out: PLDetailRow[] = [];
  // Walk sections keeping a header stack: stack[0] = top section (Income /
  // Expenses / …), deepest header = the account the Data rows belong to.
  function walk(node: any, stack: string[]) {
    if (!node) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, stack); return; }
    const header = (node.Header?.ColData?.[0]?.value || "").trim();
    const nextStack = header ? [...stack, header] : stack;
    if (node.type === "Data" && Array.isArray(node.ColData)) {
      const cd = node.ColData;
      const idCol = cd.find((c: any) => c?.id);
      const get = (i: number | undefined) => (i != null ? cd[i]?.value ?? "" : "");
      const amount = parseNum(get(idxAmt));
      if (amount != null) {
        out.push({
          txn_id: idCol?.id ? String(idCol.id) : "",
          txn_type: String(get(idxType) || ""),
          date: String(get(idxDate) || ""),
          doc_number: get(idxNum) ? String(get(idxNum)) : null,
          name: get(idxName) ? String(get(idxName)) : null,
          memo: String(get(idxMemo) || ""),
          amount,
          running_balance: null,
          account: nextStack[nextStack.length - 1] || "",
          section: nextStack[0] || "",
        });
      }
    }
    if (node.Row) walk(node.Row, nextStack);
    if (node.Rows) walk(node.Rows, nextStack);
  }
  walk(data?.Rows, []);
  return out;
}

// ─── Report row types ───────────────────────────────────────────────────────

interface ReportRow {
  type?: string;
  ColData?: { value: string; id?: string }[];
  Rows?: { Row?: ReportRow[] };
  Header?: { ColData?: { value: string }[] };
  Summary?: { ColData?: { value: string }[] };
  group?: string;
}

// Walk report rows recursively and build two maps:
//   flat:    label (lowercase) → number value  (Data rows + Section summaries)
//   items:   label → number  (only leaf Data rows, for line-level display)
//
// Each leaf data row in a P&L report carries the QBO account id on its
// first ColData entry (alongside the .value label). We capture that id
// so the client portal can drill into account transactions on click.
function flattenRows(
  rows: ReportRow[],
  flat: Map<string, number> = new Map(),
  items: { label: string; amount: number; group: string; account_id: string | null }[] = [],
  currentGroup = ""
): { flat: Map<string, number>; items: { label: string; amount: number; group: string; account_id: string | null }[] } {
  for (const row of rows || []) {
    const group = row.group || currentGroup;

    // Determine the group to propagate into child rows. Priority:
    //   1. row.group     — QBO's authoritative section type ("Income",
    //                       "COGS", "Expenses", "OtherIncome", ...)
    //   2. currentGroup  — the inherited section type from an ancestor
    //   3. headerLabel   — only as a top-level bootstrap, when neither exists
    //
    // CRITICAL: nested sub-account sections (e.g. "4000 Residential" under
    // Income, "5200 Materials" under COGS) carry NO group attribute — their
    // header is just the parent account name. We must NOT let that name
    // override the inherited section type, or every revenue/COGS line nested
    // beneath a sub-account gets misclassified. (Zuno's entire revenue was
    // landing in the expense bucket because both income lines live under a
    // "4000 Residential" parent whose header overwrote "Income".)
    const headerLabel = row.Header?.ColData?.[0]?.value?.trim() || "";
    const headerId = (row.Header?.ColData?.[0] as any)?.id || null;
    const nextGroup = row.group || currentGroup || headerLabel;

    if (row.type === "Data" && row.ColData) {
      const label = (row.ColData[0]?.value || "").trim();
      const accountId = (row.ColData[0] as any)?.id || null;
      const value = parseFloat(row.ColData[1]?.value || "0") || 0;
      if (label) {
        flat.set(label.toLowerCase(), value);
        // A Data row that ALSO has child rows is a parent ROLLUP — its value
        // includes its sub-account children, so pushing it verbatim on top of
        // those children double-counts the section. But the parent may ALSO
        // carry its OWN postings (transactions on the parent account itself,
        // e.g. Neighborhood's "Direct Field Labor – Painting": $58,470.14 on
        // the parent, zero on children). Recurse the children first, then emit
        // only the parent's own remainder (rollup − children) as its line:
        // zero for a pure rollup (no double-count), the true balance when the
        // parent holds the postings (no dropped line items on statements).
        const isRollupParent = !!(row.Rows?.Row && row.Rows.Row.length > 0);
        if (!isRollupParent) {
          items.push({ label, amount: value, group, account_id: accountId ? String(accountId) : null });
        } else {
          const before = items.length;
          flattenRows(row.Rows!.Row!, flat, items, nextGroup);
          const childSum = items.slice(before).reduce((s, it) => s + it.amount, 0);
          const own = Math.round((value - childSum) * 100) / 100;
          if (Math.abs(own) > 0.005) {
            items.push({ label, amount: own, group, account_id: accountId ? String(accountId) : null });
          }
          continue; // children already recursed above
        }
      }
    }

    if (row.Rows?.Row) {
      const before = items.length;
      flattenRows(row.Rows.Row, flat, items, nextGroup);

      if (row.type === "Section" && row.Summary?.ColData) {
        const label = (row.Summary.ColData[0]?.value || "").trim();
        const value = parseFloat(row.Summary.ColData[1]?.value || "0") || 0;
        if (label) flat.set(label.toLowerCase(), value);
        // Same parent-own-postings guarantee for the Section shape: if the
        // section total exceeds what its leaf items account for, the gap is
        // the parent account's own balance — synthesize it so line items
        // always reconcile to the section totals. Skip unnamed sections
        // (Gross Profit / Net Income summary bands have no Header).
        const childSum = items.slice(before).reduce((s, it) => s + it.amount, 0);
        const own = Math.round((value - childSum) * 100) / 100;
        if (headerLabel && Math.abs(own) > 0.005) {
          items.push({ label: headerLabel, amount: own, group, account_id: headerId ? String(headerId) : null });
        }
      }
    } else if (row.type === "Section" && row.Summary?.ColData) {
      const label = (row.Summary.ColData[0]?.value || "").trim();
      const value = parseFloat(row.Summary.ColData[1]?.value || "0") || 0;
      if (label) flat.set(label.toLowerCase(), value);
      // Childless section (all sub-accounts suppressed): the summary IS the
      // account's balance — emit it as a line so it isn't silently dropped.
      if (headerLabel && Math.abs(value) > 0.005) {
        items.push({ label: headerLabel, amount: value, group, account_id: headerId ? String(headerId) : null });
      }
    }
  }
  return { flat, items };
}

// ─── Exported types ──────────────────────────────────────────────────────────

export interface ProfitLossData {
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  /** Cost of goods sold (0 when the client has no COGS section). */
  cogs: number;
  /** Revenue − COGS. Falls back to the report's own Gross Profit row. */
  grossProfit: number;
  /** Net value of all meal/entertainment accounts found */
  mealsExpense: number;
  /** All meal/entertainment account names and amounts */
  mealsAccounts: { label: string; amount: number }[];
  /** Every line item in the P&L for display */
  lineItems: { label: string; amount: number; group: string; account_id: string | null }[];
}

export interface GstHstAccount {
  name: string;
  id: string;
  balance: number;
  type: "payable" | "receivable" | "other";
}

// ─── Fetch P&L ───────────────────────────────────────────────────────────────

export async function fetchProfitAndLoss(
  realmId: string,
  accessToken: string,
  startDate: string,
  endDate: string,
  // Accounting basis. Defaults to CASH — IronBooks does cash accounting, and
  // statements carry a cash-basis Notice to Reader. (Until 2026-07-02 this was
  // hardcoded Accrual, so every published statement was accrual mislabeled as
  // cash.) Pass "Accrual" explicitly for comparisons/audits.
  method: "Accrual" | "Cash" = "Cash"
): Promise<ProfitLossData> {
  if (isDemoRealm(realmId)) return demoProfitAndLoss(startDate);
  const report = await fetchQBOReport(realmId, accessToken, "ProfitAndLoss", {
    start_date: startDate,
    end_date: endDate,
    accounting_method: method,
  });

  const rawRows: ReportRow[] = report?.Rows?.Row || [];
  const { flat, items } = flattenRows(rawRows);

  const totalIncome =
    flat.get("total income") ??
    flat.get("total revenue") ??
    flat.get("gross profit") ??
    0;
  const totalExpenses =
    flat.get("total expenses") ?? flat.get("total expense") ?? 0;
  // Net income — compute it from the leaf accounts rather than trusting QBO's
  // "Net Income" summary row. On a P&L that has Cost of Goods Sold / Other
  // Income / Other Expense sections, QBO's report doesn't always emit the
  // bottom-line row our matcher expected, so net income silently fell back to
  // 0 (showed $0 even with real income + expenses — BMD Painting: $228k income,
  // $155k COGS, $79k expenses, net "$0"). Summing the leaves we already display
  // (revenue groups add, COGS/Expenses/Other Expense subtract) guarantees the
  // bottom line reconciles with the sections on screen. Prefer QBO's own row
  // only when it's actually present and non-zero.
  let revenueSum = 0;
  let expenseSum = 0;
  for (const it of items) {
    if (/income|revenue/i.test(it.group)) revenueSum += it.amount;
    else expenseSum += it.amount;
  }
  const computedNet = revenueSum - expenseSum;
  const reportedNet =
    flat.get("net income") ?? flat.get("net loss") ?? flat.get("net earnings") ?? null;
  const netIncome = reportedNet != null && Math.abs(reportedNet) > 0.005 ? reportedNet : computedNet;

  // Cost of goods sold + gross profit, so summaries can show a reconciling
  // Revenue − COGS = Gross profit − Expenses = Net breakdown (painting clients
  // often carry a big COGS section; omitting it makes income − expenses look
  // like it doesn't equal net).
  const cogs = Math.abs(
    flat.get("total cost of goods sold") ??
      flat.get("cost of goods sold") ??
      flat.get("total cogs") ??
      flat.get("cogs") ??
      0
  );
  const grossProfitRow = flat.get("gross profit") ?? flat.get("total gross profit") ?? null;
  const grossProfit =
    grossProfitRow != null ? Math.abs(grossProfitRow) : Math.abs(totalIncome) - cogs;

  // Match meal/entertainment accounts by common name variants
  const mealPatterns = [
    "meals and entertainment",
    "meals & entertainment",
    "meals & ent",
    "entertainment",
    "business meals",
    "meals",
    "client entertainment",
    "staff meals",
    "food and entertainment",
  ];

  const mealsAccounts = items.filter(({ label }) =>
    mealPatterns.some((p) => label.toLowerCase().includes(p))
  );
  const mealsExpense = mealsAccounts.reduce((s, a) => s + Math.abs(a.amount), 0);

  return {
    totalIncome: Math.abs(totalIncome),
    totalExpenses: Math.abs(totalExpenses),
    netIncome,
    cogs,
    grossProfit,
    mealsExpense,
    mealsAccounts,
    lineItems: items,
  };
}

// ─── Cash Flow Statement ─────────────────────────────────────────────────────

export interface CashFlowLineItem {
  label: string;
  amount: number;
}

export interface CashFlowSection {
  title: string;
  total: number;
  items: CashFlowLineItem[];
}

export interface CashFlowData {
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netCashChange: number;
  cashAtStart: number;
  cashAtEnd: number;
}

/**
 * QBO CashFlow report (indirect method). Top-level sections are
 * OPERATING / INVESTING / FINANCING ACTIVITIES, each with leaf line
 * items and a "Net cash provided by …" summary, followed by standalone
 * net-change / beginning-cash / ending-cash rows.
 *
 * Section matching is on the header text OR the row group attribute —
 * QBO emits "OperatingActivities" as group on some realms and only the
 * header label on others.
 */
export async function fetchCashFlow(
  realmId: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<CashFlowData> {
  const report = await fetchQBOReport(realmId, accessToken, "CashFlow", {
    start_date: startDate,
    end_date: endDate,
  });

  const rawRows: ReportRow[] = report?.Rows?.Row || [];
  const { flat } = flattenRows(rawRows);

  function collectSection(keyword: string, fallbackTitle: string): CashFlowSection {
    for (const row of rawRows) {
      const header = (row.Header?.ColData?.[0]?.value || "").toLowerCase();
      const group = ((row as any).group || "").toLowerCase();
      if (!header.includes(keyword) && !group.includes(keyword)) continue;

      const items: CashFlowLineItem[] = [];
      (function walk(rs: any[]) {
        for (const r of rs || []) {
          if (r.type === "Data" && r.ColData) {
            const label = (r.ColData[0]?.value || "").trim();
            const amount = parseFloat(r.ColData[1]?.value || "0") || 0;
            if (label) items.push({ label, amount });
          }
          if (r.Rows?.Row) walk(r.Rows.Row);
        }
      })(row.Rows?.Row || []);

      const total = parseFloat(row.Summary?.ColData?.[1]?.value || "0") || 0;
      const title = (row.Header?.ColData?.[0]?.value || fallbackTitle).trim();
      return { title, total, items };
    }
    return { title: fallbackTitle, total: 0, items: [] };
  }

  // Standalone summary rows land in the flat map via flattenRows.
  const lookup = (...keys: string[]): number => {
    for (const k of keys) {
      const v = flat.get(k);
      if (v !== undefined) return v;
    }
    return 0;
  };

  const netCashChange = lookup(
    "net cash increase for period",
    "net cash decrease for period",
    "net cash increase (decrease) for period"
  );
  const cashAtEnd = lookup("cash at end of period");
  // QBO omits the "Cash at beginning of period" row on some realms (seen
  // live: report carries only net-change + end-cash). When absent, derive
  // it — beginning = ending − net change is the identity the statement is
  // built on.
  const cashAtStart = flat.has("cash at beginning of period")
    ? (flat.get("cash at beginning of period") as number)
    : cashAtEnd - netCashChange;

  return {
    operating: collectSection("operating", "Operating activities"),
    investing: collectSection("investing", "Investing activities"),
    financing: collectSection("financing", "Financing activities"),
    netCashChange,
    cashAtStart,
    cashAtEnd,
  };
}

// ─── Find GST/HST accounts from the fetched account list ────────────────────
// Using the account list (rather than Balance Sheet report) is simpler and
// gives us CurrentBalance directly. Limitation: CurrentBalance reflects the
// current date, not the end of the selected period — noted in the UI.

export function extractGstHstAccounts(accounts: any[]): GstHstAccount[] {
  const taxKeywords = ["gst", "hst", "sales tax", "tax payable", "tax receivable", "input tax"];
  return accounts
    .filter((a: any) => {
      const name = (a.Name || "").toLowerCase();
      return taxKeywords.some((kw) => name.includes(kw));
    })
    .map((a: any) => {
      const name: string = a.Name;
      const nameLower = name.toLowerCase();
      const accountType: string = (a.AccountType || "").toLowerCase();
      const type: "payable" | "receivable" | "other" =
        nameLower.includes("payable") || accountType === "other current liability"
          ? "payable"
          : nameLower.includes("receivable") || nameLower.includes("itc") || nameLower.includes("input tax") || accountType === "other current asset"
          ? "receivable"
          : "other";
      return {
        name,
        id: a.Id as string,
        balance: (a.CurrentBalanceWithSubAccounts ?? a.CurrentBalance ?? 0) as number,
        type,
      };
    });
}
