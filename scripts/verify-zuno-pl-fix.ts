/**
 * READ-ONLY verification that the flattenRows fix produces correct buckets
 * for Zuno via the REAL lib functions (fetchProfitAndLoss + classifyProfitLoss).
 * Run: npx tsx scripts/verify-zuno-pl-fix.ts
 */
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.QBO_ENVIRONMENT = "production";

import { createClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo-reclass";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { classifyProfitLoss } from "@/lib/portal-pl";

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

(async () => {
  const { data: clients } = await supa
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .ilike("client_name", "%zuno%");
  const client = (clients as any[])!.find((x) => x.qbo_realm_id);
  const token = await getValidToken(client.id, supa as any, "verify/zuno-pl");

  const pl = await fetchProfitAndLoss(client.qbo_realm_id, token, "2026-01-01", "2026-06-09");
  const c = classifyProfitLoss(pl);

  console.log(`\nZuno — ${client.qbo_realm_id}  (2026-01-01 .. 2026-06-09)\n`);
  console.log(`report totals:  income=${money(pl.totalIncome)}  expenses=${money(pl.totalExpenses)}  net=${money(pl.netIncome)}`);
  console.log(`hasCogsSection=${c.hasCogsSection}  costSplitEstimated=${c.costSplitEstimated}\n`);

  const dump = (label: string, b: any) => {
    if (!b) return;
    console.log(`  ${label}  total=${money(b.total)}  (${b.lines.length} lines)`);
    for (const l of b.lines) console.log(`      ${l.label}  ${money(Math.abs(l.amount))}`);
  };
  dump("INCOME", c.income);
  dump("VARIABLE (COGS)", c.variableCosts);
  dump("FIXED", c.fixedExpenses);
  dump("OTHER INCOME", c.otherIncome);
  dump("OTHER EXPENSE", c.otherExpense);

  console.log(`\n  grossProfit=${money(c.grossProfit)} (${c.grossMarginPct.toFixed(1)}%)   netProfit=${money(c.netProfit)} (${c.netMarginPct.toFixed(1)}%)`);

  // Sanity: income bucket total should match report total income.
  const ok = Math.abs(c.income.total - pl.totalIncome) < 1;
  console.log(`\n  income bucket matches report total income: ${ok ? "YES ✓" : "NO ✗"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("verify failed:", e?.message || e);
  process.exit(1);
});
