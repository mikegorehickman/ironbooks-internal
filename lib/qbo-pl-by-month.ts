/**
 * QBO ProfitAndLoss summarized BY MONTH — one column per month plus a Total
 * column. Parsed into ordered blocks that mirror the statement: each section
 * (Income / COGS / Expenses / Other …) with its leaf accounts and a per-month
 * section total, plus the standalone summary lines QBO emits (Gross Profit,
 * Net Operating Income, Net Income). Nested sub-accounts flatten to
 * "Parent:Child" leaf rows.
 *
 * Self-contained (own report fetch) so it doesn't depend on internals of
 * lib/qbo-reports.ts.
 */

import { isDemoRealm, demoProfitAndLossByMonth } from "./demo-data";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

async function fetchReport(
  realmId: string,
  accessToken: string,
  reportName: string,
  params: Record<string, string>
): Promise<any> {
  const qs = new URLSearchParams({ ...params, minorversion: "65" });
  const url = `${QBO_BASE}/v3/company/${realmId}/reports/${reportName}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO ${reportName} report failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

export interface PLMonthCol {
  title: string; // e.g. "Apr 2026"
}
export interface PLByMonthAccount {
  name: string;
  values: number[]; // one per month column, aligned to months[]
  total: number;
}
export type PLByMonthBlock =
  | {
      kind: "section";
      title: string; // "Income", "Cost of Goods Sold", "Expenses", ...
      totalLabel: string; // QBO's summary label, e.g. "Total Income"
      accounts: PLByMonthAccount[];
      totals: number[]; // section total per month
      total: number;
    }
  | {
      kind: "summary";
      title: string; // "Gross Profit", "Net Operating Income", "Net Income"
      values: number[];
      total: number;
    };
export interface ProfitLossByMonth {
  months: PLMonthCol[];
  blocks: PLByMonthBlock[];
}

export async function fetchProfitAndLossByMonth(
  realmId: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<ProfitLossByMonth> {
  if (isDemoRealm(realmId)) return demoProfitAndLossByMonth();
  const report = await fetchReport(realmId, accessToken, "ProfitAndLoss", {
    start_date: startDate,
    end_date: endDate,
    // Cash — IronBooks does cash accounting; must match statements/portal P&L.
    accounting_method: "Cash",
    summarize_column_by: "Month",
  });

  const columns: any[] = report?.Columns?.Column || [];
  // Column 0 is the account label; the rest are month columns + a Total column.
  const valueCols = columns.slice(1).map((c: any, i: number) => ({
    idx: i + 1,
    title: String(c?.ColTitle || "").trim(),
    isTotal: String(c?.ColTitle || "").trim().toLowerCase() === "total",
  }));
  const monthColIdx = valueCols.filter((c) => !c.isTotal).map((c) => c.idx);
  const totalIdx = valueCols.find((c) => c.isTotal)?.idx ?? null;
  const months: PLMonthCol[] = valueCols
    .filter((c) => !c.isTotal)
    .map((c) => ({ title: c.title }));

  const num = (v: any) => {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };
  const extract = (colData: any[] | undefined) => {
    const values = monthColIdx.map((i) => num(colData?.[i]?.value));
    const total =
      totalIdx != null ? num(colData?.[totalIdx]?.value) : values.reduce((a, b) => a + b, 0);
    return { values, total };
  };

  // Walk a section's rows, flattening nested sub-accounts to "Parent:Child".
  const collectLeaves = (rows: any[], prefix: string, out: PLByMonthAccount[]) => {
    for (const r of rows) {
      const name = String(r?.Header?.ColData?.[0]?.value || r?.ColData?.[0]?.value || "").trim();
      if (r?.Rows?.Row) {
        collectLeaves(r.Rows.Row, prefix ? `${prefix}:${name}` : name, out);
      } else if (r?.ColData) {
        const leaf = prefix ? `${prefix}:${name}` : name;
        if (!leaf) continue;
        const { values, total } = extract(r.ColData);
        out.push({ name: leaf, values, total });
      }
    }
  };

  const blocks: PLByMonthBlock[] = [];
  const topRows: any[] = report?.Rows?.Row || [];
  for (const row of topRows) {
    if (row?.Rows?.Row) {
      const title = String(row?.Header?.ColData?.[0]?.value || "").trim() || "Section";
      const accounts: PLByMonthAccount[] = [];
      collectLeaves(row.Rows.Row, "", accounts);
      const sum = row?.Summary?.ColData;
      const totalLabel = String(sum?.[0]?.value || `Total ${title}`).trim();
      const { values: totals, total } = extract(sum);
      blocks.push({ kind: "section", title, totalLabel, accounts, totals, total });
    } else if (row?.Summary?.ColData || row?.ColData) {
      const cd = row?.Summary?.ColData || row?.ColData;
      const title = String(cd?.[0]?.value || "").trim();
      if (!title) continue;
      const { values, total } = extract(cd);
      blocks.push({ kind: "summary", title, values, total });
    }
  }

  return { months, blocks };
}
