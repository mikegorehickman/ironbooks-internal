/**
 * READ-ONLY diagnostic for Clean Cut's CRM-caused duplicate problem.
 *
 * User finding: 95%+ of the $338K UF balance are DUPLICATE payments whose
 * real twin was already deposited. Both UF and A/R are overstated.
 *
 * Voiding a duplicate Payment reverses Dr UF / Cr A/R — UF goes down but
 * any invoice it was applied to RE-OPENS (A/R goes UP). To reduce both UF
 * and A/R we likely need to void the duplicate INVOICE too.
 *
 * This script characterizes the exact shape so we build the right fix:
 *   1. Run the UF Audit engine (orphans + duplicate detection).
 *   2. For each orphan: is it applied to invoices? Are those invoices
 *      still open or closed? Is the invoice itself a duplicate (same
 *      customer + amount as another invoice)?
 *   3. Tally: what happens to UF and A/R under
 *        (a) void payment only
 *        (b) void payment + void its applied duplicate invoice
 *
 * ZERO writes. Run: npx tsx scripts/diagnose-clean-cut-duplicates.ts
 */
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.QBO_ENVIRONMENT = "production";

import { createClient } from "@supabase/supabase-js";
import { getValidToken, qboRateLimiter } from "@/lib/qbo";
import { findUndepositedFundsAccountId } from "@/lib/qbo-balance-sheet";
import { scanUfAudit } from "@/lib/uf-audit";

const CC = "1bc21a0e-7655-4543-9006-97e0eada7130";
const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function qbo<T>(realm: string, token: string, ep: string): Promise<T> {
  await qboRateLimiter.throttle(realm);
  const res = await fetch(`${QBO_BASE}/${realm}${ep}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`QBO ${res.status} on ${ep}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const { data: client } = await svc
    .from("client_links")
    .select("id, qbo_realm_id, client_name")
    .eq("id", CC)
    .single();
  const realm = (client as any).qbo_realm_id;
  const token = await getValidToken(CC, svc as any);

  const ufId = await findUndepositedFundsAccountId(realm, token);
  if (!ufId) throw new Error("No UF account");
  const scan = await scanUfAudit(realm, token, ufId);

  const orphans = scan.payments.filter((p) => p.classification === "orphan");
  const dups = orphans.filter((p) => p.suspected_duplicate);
  console.log(`\n=== UF Audit engine result ===`);
  console.log(`payments: ${scan.payments_total}  matched: ${scan.matched_count}  orphans: ${scan.orphan_count}`);
  console.log(`orphan total: $${scan.total_orphan_amount.toFixed(2)}`);
  console.log(`auto-flagged duplicates: ${dups.length}  ($${dups.reduce((s, p) => s + p.payment_amount, 0).toFixed(2)})`);

  // Pull ALL invoices (open + paid) for the scan window to evaluate invoice state
  const invById = new Map<string, any>();
  let start = 1;
  for (;;) {
    const r: any = await qbo(realm, token,
      `/query?query=${encodeURIComponent(`SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef FROM Invoice STARTPOSITION ${start} MAXRESULTS 1000`)}&minorversion=70`);
    const rows = r?.QueryResponse?.Invoice || [];
    for (const inv of rows) invById.set(String(inv.Id), inv);
    if (rows.length < 1000) break;
    start += 1000;
  }
  console.log(`invoices fetched: ${invById.size}`);

  // Characterize each orphan
  let applied_open = 0, applied_closed = 0, unapplied = 0;
  let amtApplied = 0, amtUnapplied = 0;
  const invoiceVoidCandidates: { pay: string; cust: string; amt: number; invIds: string[] }[] = [];
  for (const p of orphans) {
    if (p.applied_invoice_ids.length === 0) {
      unapplied++; amtUnapplied += p.payment_amount;
      continue;
    }
    amtApplied += p.payment_amount;
    const invs = p.applied_invoice_ids.map((id) => invById.get(String(id))).filter(Boolean);
    const anyOpen = invs.some((i) => Number(i.Balance) > 0);
    if (anyOpen) applied_open++; else applied_closed++;
    if (p.suspected_duplicate) {
      invoiceVoidCandidates.push({
        pay: p.qbo_payment_id,
        cust: p.customer_name || "?",
        amt: p.payment_amount,
        invIds: p.applied_invoice_ids,
      });
    }
  }
  console.log(`\n=== orphan shape ===`);
  console.log(`applied to invoice(s): ${applied_open + applied_closed}  ($${amtApplied.toFixed(2)})`);
  console.log(`   · invoice fully paid (closed): ${applied_closed}`);
  console.log(`   · invoice still has balance:   ${applied_open}`);
  console.log(`unapplied (no invoice):        ${unapplied}  ($${amtUnapplied.toFixed(2)})`);

  // Duplicate-invoice check: does each duplicate payment's invoice have a
  // same-customer same-amount twin?
  const invList = Array.from(invById.values());
  let dupInvHits = 0;
  console.log(`\n=== duplicate payments → their invoices (first 15) ===`);
  for (const c of invoiceVoidCandidates.slice(0, 15)) {
    for (const id of c.invIds) {
      const inv = invById.get(String(id));
      if (!inv) { console.log(`pay ${c.pay} ${c.cust} $${c.amt} → invoice ${id} NOT FOUND`); continue; }
      const twins = invList.filter(
        (i) => i.Id !== inv.Id &&
          i.CustomerRef?.value === inv.CustomerRef?.value &&
          Math.abs(Number(i.TotalAmt) - Number(inv.TotalAmt)) < 0.01
      );
      if (twins.length > 0) dupInvHits++;
      console.log(
        `pay ${c.pay} ${c.cust} $${c.amt} → inv#${inv.DocNumber} (bal $${inv.Balance}, total $${inv.TotalAmt})` +
          (twins.length ? `  TWIN: inv#${twins.map((t: any) => `${t.DocNumber}(bal $${t.Balance})`).join(", ")}` : "  no twin")
      );
    }
  }
  console.log(`\nduplicate payments whose invoice has a same-customer/amount twin: ${dupInvHits}/${Math.min(15, invoiceVoidCandidates.length)} sampled`);

  // A/R + UF current balances for reference
  console.log(`\nUF account balance (QBO): $${scan.uf_account_current_balance.toFixed(2)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
