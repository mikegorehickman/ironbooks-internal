/**
 * READ-ONLY diagnostic for the Zuno P&L "missing revenue lines" bug.
 *
 * Pulls Zuno's raw ProfitAndLoss report tree from QBO (production) and:
 *   1. Prints the section tree with each row's `group` attr + header label
 *   2. Runs the CURRENT flatten logic and the FIXED flatten logic
 *   3. Diffs the per-line `group` assignment so we can see which revenue
 *      sub-account lines the old code mislabels (header label) vs the new
 *      code (inherited section group).
 *
 * Makes ZERO writes. Run: npx tsx scripts/diagnose-zuno-pl.ts
 */
import { readFileSync } from "fs";

// Load .env.local before importing anything that reads env.
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Zuno is a real production client; force the production QBO host regardless
// of what QBO_ENVIRONMENT is set to locally (it's blank in .env.local).
process.env.QBO_ENVIRONMENT = "production";

import { createClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo-reclass";

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface ReportRow {
  type?: string;
  ColData?: { value: string; id?: string }[];
  Rows?: { Row?: ReportRow[] };
  Header?: { ColData?: { value: string }[] };
  Summary?: { ColData?: { value: string }[] };
  group?: string;
}

// ─── CURRENT (buggy) flatten ──────────────────────────────────────────────
function flattenOld(
  rows: ReportRow[],
  items: { label: string; group: string }[] = [],
  currentGroup = ""
): { label: string; group: string }[] {
  for (const row of rows || []) {
    const group = row.group || currentGroup;
    if (row.type === "Data" && row.ColData) {
      const label = (row.ColData[0]?.value || "").trim();
      if (label) items.push({ label, group });
    }
    const sectionGroup = row.Header?.ColData?.[0]?.value?.trim() || group;
    if (row.Rows?.Row) flattenOld(row.Rows.Row, items, sectionGroup);
  }
  return items;
}

// ─── FIXED flatten — header label only bootstraps when no group exists ────
function flattenNew(
  rows: ReportRow[],
  items: { label: string; group: string }[] = [],
  currentGroup = ""
): { label: string; group: string }[] {
  for (const row of rows || []) {
    const group = row.group || currentGroup;
    if (row.type === "Data" && row.ColData) {
      const label = (row.ColData[0]?.value || "").trim();
      if (label) items.push({ label, group });
    }
    const headerLabel = row.Header?.ColData?.[0]?.value?.trim() || "";
    const nextGroup = row.group || currentGroup || headerLabel;
    if (row.Rows?.Row) flattenNew(row.Rows.Row, items, nextGroup);
  }
  return items;
}

// classifier mirror (from lib/portal-pl.ts)
const isIncomeGroup = (g: string) => {
  const x = g.toLowerCase();
  if (/other\s*income/.test(x)) return false;
  return /income|revenue|sales/.test(x) && !/cost/.test(x);
};
const isCogsGroup = (g: string) =>
  /cogs|cost of goods|cost of sales|job cost|direct cost/.test(g.toLowerCase());

function bucketOf(g: string): string {
  if (/other\s*income/i.test(g)) return "otherIncome";
  if (/other\s*expense/i.test(g)) return "otherExpense";
  if (isIncomeGroup(g)) return "income";
  if (isCogsGroup(g)) return "cogs";
  return "expense(heuristic)";
}

function printTree(rows: ReportRow[], depth = 0) {
  for (const row of rows || []) {
    const pad = "  ".repeat(depth);
    const header = row.Header?.ColData?.[0]?.value?.trim();
    const grp = row.group ? c.green(`group="${row.group}"`) : c.dim("group=∅");
    if (header) {
      console.log(`${pad}${c.bold("§ " + header)}  ${grp}  ${c.dim("type=" + (row.type || "?"))}`);
    } else if (row.type === "Data" && row.ColData) {
      const label = (row.ColData[0]?.value || "").trim();
      const amt = row.ColData[1]?.value || "";
      if (label) console.log(`${pad}${c.blue(label)} ${c.dim("(" + amt + ")")} ${grp}`);
    }
    if (row.Rows?.Row) printTree(row.Rows.Row, depth + 1);
    if (row.type === "Section" && row.Summary?.ColData) {
      const label = (row.Summary.ColData[0]?.value || "").trim();
      const amt = row.Summary.ColData[1]?.value || "";
      if (label) console.log(`${pad}${c.dim("Σ " + label + " = " + amt)}`);
    }
  }
}

const QBO_BASE = "https://quickbooks.api.intuit.com";

(async () => {
  console.log(c.bold("\nZuno P&L diagnostic (READ-ONLY)\n"));

  // 1. Find Zuno's client_link
  const { data: clients, error } = await supa
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .ilike("client_name", "%zuno%");
  if (error) throw new Error(error.message);
  if (!clients || clients.length === 0) throw new Error("No client matching '%zuno%'");
  const client = (clients as any[]).find((x) => x.qbo_realm_id) || (clients as any[])[0];
  console.log(`  client: ${c.blue(client.client_name)} (${client.id}) realm=${client.qbo_realm_id} active=${client.is_active}`);
  if (!client.qbo_realm_id) throw new Error("Zuno client_link has no qbo_realm_id");

  // 2. Token
  const token = await getValidToken(client.id, supa as any, "diagnose/zuno-pl");

  // 3. Fetch raw P&L for a range likely to have data. Try a few windows.
  const ranges = [
    ["2026-01-01", "2026-06-09"],
    ["2025-01-01", "2025-12-31"],
    ["2024-01-01", "2024-12-31"],
  ];
  let report: any = null;
  let usedRange: string[] = [];
  for (const [start, end] of ranges) {
    const qs = new URLSearchParams({
      start_date: start,
      end_date: end,
      accounting_method: "Accrual",
      minorversion: "65",
    });
    const url = `${QBO_BASE}/v3/company/${client.qbo_realm_id}/reports/ProfitAndLoss?${qs}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      console.log(c.red(`  fetch ${start}..${end} failed (${res.status})`));
      continue;
    }
    const json = await res.json();
    const rows = json?.Rows?.Row || [];
    const old = flattenOld(rows);
    if (old.length > 0) {
      report = json;
      usedRange = [start, end];
      break;
    }
    console.log(c.dim(`  ${start}..${end}: 0 line items, trying next range`));
  }
  if (!report) throw new Error("No range returned P&L line items");
  console.log(`  range: ${c.blue(usedRange.join(" .. "))}\n`);

  const rows: ReportRow[] = report?.Rows?.Row || [];

  console.log(c.bold("─── Raw section tree ───"));
  printTree(rows);

  const oldItems = flattenOld(rows);
  const newItems = flattenNew(rows);

  console.log(c.bold("\n─── Per-line group / bucket: OLD vs NEW ───"));
  let changed = 0;
  let revenueRescued = 0;
  for (let i = 0; i < oldItems.length; i++) {
    const o = oldItems[i];
    const n = newItems[i];
    const oldBucket = bucketOf(o.group);
    const newBucket = bucketOf(n.group);
    if (o.group !== n.group || oldBucket !== newBucket) {
      changed++;
      const rescued = oldBucket !== "income" && newBucket === "income";
      if (rescued) revenueRescued++;
      console.log(
        `  ${rescued ? c.green("✚") : c.yellow("~")} ${o.label}\n` +
          `      old: group="${o.group}" → ${oldBucket}\n` +
          `      new: group="${n.group}" → ${c.green(newBucket)}`
      );
    }
  }
  if (changed === 0) console.log(c.dim("  (no lines change group — bug may not reproduce on this file)"));

  // Income totals comparison
  const oldIncomeLines = oldItems.filter((x) => bucketOf(x.group) === "income");
  const newIncomeLines = newItems.filter((x) => bucketOf(x.group) === "income");
  console.log(c.bold("\n─── Summary ───"));
  console.log(`  total line items:        ${oldItems.length}`);
  console.log(`  lines that change group: ${changed}`);
  console.log(`  revenue lines rescued:   ${revenueRescued > 0 ? c.green(String(revenueRescued)) : "0"}`);
  console.log(`  income lines OLD: ${c.yellow(String(oldIncomeLines.length))}  →  NEW: ${c.green(String(newIncomeLines.length))}`);

  console.log(c.green("\n✓ diagnostic complete (no writes)\n"));
  process.exit(0);
})().catch((e) => {
  console.error(c.red("\n✗ diagnostic failed:"), e?.message || e);
  process.exit(1);
});
