/**
 * QBO Reports API — fetch and parse P&L and account data for tax audit.
 *
 * QBO report responses are deeply nested. We use a recursive flattener to
 * build a label→value map, then look up keys by common name variants.
 */

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
      accounting_method: "Accrual",
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

    if (row.type === "Data" && row.ColData) {
      const label = (row.ColData[0]?.value || "").trim();
      const accountId = (row.ColData[0] as any)?.id || null;
      const value = parseFloat(row.ColData[1]?.value || "0") || 0;
      if (label) {
        flat.set(label.toLowerCase(), value);
        items.push({ label, amount: value, group, account_id: accountId ? String(accountId) : null });
      }
    }

    const sectionGroup =
      row.Header?.ColData?.[0]?.value?.trim() || group;

    if (row.Rows?.Row) {
      flattenRows(row.Rows.Row, flat, items, sectionGroup);
    }

    if (row.type === "Section" && row.Summary?.ColData) {
      const label = (row.Summary.ColData[0]?.value || "").trim();
      const value = parseFloat(row.Summary.ColData[1]?.value || "0") || 0;
      if (label) flat.set(label.toLowerCase(), value);
    }
  }
  return { flat, items };
}

// ─── Exported types ──────────────────────────────────────────────────────────

export interface ProfitLossData {
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
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
  endDate: string
): Promise<ProfitLossData> {
  const report = await fetchQBOReport(realmId, accessToken, "ProfitAndLoss", {
    start_date: startDate,
    end_date: endDate,
    accounting_method: "Accrual",
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
  const netIncome =
    flat.get("net income") ??
    flat.get("net loss") ??
    flat.get("net earnings") ??
    0;

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
    mealsExpense,
    mealsAccounts,
    lineItems: items,
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
