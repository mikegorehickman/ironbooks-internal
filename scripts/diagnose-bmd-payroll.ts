/**
 * READ-ONLY diagnostic for the BMD payroll double-count (Mike, 2026-07-16:
 * "QBO is taking the expense (net pay) and the direct deposit (gross pay) and
 * adding them both to the wages account"). Same pattern seen at Taro Painting.
 *
 * Pulls every payroll-ish P&L account's transactions from BMD's live QBO and:
 *   1. Groups by txn_type (count + sum) so we see WHAT is posting to wages.
 *   2. Dumps each transaction (date/type/doc/name/memo/amount).
 *   3. Runs the EXISTING equal-amount detector (detectPayrollDoubleEntries).
 *   4. Runs a GROSS+NET probe: same-day clusters of 2+ postings of DIFFERENT
 *      amounts (the variant the equal-amount detector misses).
 *
 * ZERO writes. Run: npx tsx scripts/diagnose-bmd-payroll.ts [clientNameLike]
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
import { fetchAllAccounts } from "@/lib/qbo";
import { fetchAccountTransactions, type AccountTransaction } from "@/lib/qbo-balance-sheet";
import { detectPayrollDoubleEntries, PAYROLL_ACCOUNT_NAME_REGEX } from "@/lib/payroll-double-entry";

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const nameLike = process.argv[2] || "BMD";
const START = "2026-01-01";
const END = "2026-06-30";

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

(async () => {
  const { data: clients } = await supa
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .ilike("client_name", `%${nameLike}%`)
    .eq("is_active", true);
  if (!clients || clients.length === 0) { console.log(`No active client matching "${nameLike}"`); process.exit(1); }
  const client: any = clients[0];
  console.log(`\nClient: ${client.client_name}  (realm ${client.qbo_realm_id})  window ${START} → ${END}\n`);

  const token = await getValidToken(client.id, supa as any, "diagnose-bmd-payroll");
  const accounts = await fetchAllAccounts(client.qbo_realm_id, token);

  // Payroll-ish P&L accounts (same filter as the scan route) + show what matched.
  const payroll = accounts.filter((a) => {
    const t = String(a.AccountType || "").toLowerCase();
    const isExpenseSide = t.includes("expense") || t.includes("cost of goods") || t.includes("cogs");
    return isExpenseSide && PAYROLL_ACCOUNT_NAME_REGEX.test(a.Name || "");
  });
  console.log(`Payroll-ish P&L accounts matched (${payroll.length}):`);
  for (const a of payroll) console.log(`  - ${a.Name}  [${a.AccountType}]  id=${a.Id}`);
  console.log("");

  const accountsByPayroll: Array<{ account_id: string; account_name: string; transactions: AccountTransaction[] }> = [];
  for (const a of payroll) {
    const txns = await fetchAccountTransactions(client.qbo_realm_id, token, a.Id, START, END, a.Name);
    accountsByPayroll.push({ account_id: a.Id, account_name: a.Name, transactions: txns });

    // (1) group by txn_type
    console.log(`\n═══ ${a.Name}  (${txns.length} txns) ═══`);
    const byType = new Map<string, { n: number; sum: number }>();
    for (const t of txns) {
      const k = t.txn_type || "(none)";
      const g = byType.get(k) || { n: 0, sum: 0 };
      g.n++; g.sum += Math.abs(t.amount);
      byType.set(k, g);
    }
    for (const [k, g] of [...byType.entries()].sort((x, y) => y[1].sum - x[1].sum)) {
      console.log(`   ${k.padEnd(18)} ${String(g.n).padStart(4)} txns   ${money(g.sum).padStart(14)}`);
    }

    // (2) dump each txn
    console.log(`   ── transactions ──`);
    for (const t of [...txns].sort((x, y) => x.date.localeCompare(y.date))) {
      console.log(`   ${t.date}  ${(t.txn_type || "").padEnd(16)}  ${(t.doc_number || "").padEnd(8)}  ${(t.customer_or_vendor || "").slice(0, 22).padEnd(22)}  ${money(t.amount).padStart(13)}  ${(t.memo || "").slice(0, 30)}`);
    }

    // (4) gross+net probe: same-day clusters with >=2 different amounts
    const byDate = new Map<string, AccountTransaction[]>();
    for (const t of txns) {
      const d = t.date.slice(0, 10);
      (byDate.get(d) || byDate.set(d, []).get(d)!).push(t);
    }
    const clusters = [...byDate.entries()].filter(([, ts]) => {
      const amts = new Set(ts.map((t) => Math.abs(t.amount).toFixed(2)));
      return ts.length >= 2 && amts.size >= 2;
    });
    if (clusters.length) {
      console.log(`   ⚠ GROSS+NET candidates (same day, 2+ different amounts):`);
      for (const [d, ts] of clusters) {
        console.log(`      ${d}: ${ts.map((t) => `${t.txn_type} ${money(Math.abs(t.amount))}`).join("  |  ")}`);
      }
    }
  }

  // (3) existing equal-amount detector
  const pairs = detectPayrollDoubleEntries({ accountsByPayroll });
  console.log(`\n\n═══ EXISTING equal-amount detector: ${pairs.length} pair(s) ═══`);
  let dupTotal = 0;
  for (const p of pairs) {
    dupTotal += Math.abs(p.duplicate_amount);
    console.log(`   [${(p.confidence * 100).toFixed(0)}%] ${p.duplicate_account_name}: ${p.duplicate_txn_type} ${money(Math.abs(p.duplicate_amount))} (${p.duplicate_date}) ↔ locked ${p.locked_txn_type} (${p.locked_date})`);
  }
  console.log(`   equal-amount double-booked total: ${money(dupTotal)}`);
  console.log("");
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
