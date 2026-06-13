/**
 * READ-ONLY diagnostic for the Clean Cut Painters "A/R module finds nothing"
 * bug. The Balance Sheet shows $338,226 in Undeposited Funds and $681,549 in
 * A/R, yet the UF→A/R matcher returns zero proposed entries.
 *
 * This makes ZERO writes. It reproduces exactly what the matcher sees:
 *   1. Which account the UF lookup resolves to (subtype gate)
 *   2. All "Other Current Asset" accounts + balances (to spot a UF account
 *      that ISN'T subtype=UndepositedFunds)
 *   3. Count + sum of Payments deposited to UF (what the matcher pulls)
 *   4. Count + sum of SalesReceipts deposited to UF (what it MISSES today)
 *   5. Count + sum of open invoices (A/R candidates)
 *   6. matchUFtoAR breakdown by kind
 *
 * Run: npx tsx scripts/diagnose-clean-cut-uf-ar.ts
 */
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.QBO_ENVIRONMENT = "production";

import { createClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo";
import {
  fetchOpenInvoices,
  fetchUndepositedFundsPayments,
  findUndepositedFundsAccountId,
} from "@/lib/qbo-balance-sheet";
import { matchUFtoAR } from "@/lib/uf-ar-matcher";

const CLIENT_LINK_ID = "1bc21a0e-7655-4543-9006-97e0eada7130"; // Clean Cut Painters
const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function q(realm: string, token: string, query: string): Promise<any> {
  const url = `${QBO_BASE}/${realm}/query?query=${encodeURIComponent(query)}&minorversion=70`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(red(`QBO query failed (${res.status}): ${query}`));
    console.error(dim(await res.text()));
    return {};
  }
  return res.json();
}

async function main() {
  const { data: client } = await supa
    .from("client_links")
    .select("qbo_realm_id, client_name")
    .eq("id", CLIENT_LINK_ID)
    .single();
  if (!client) throw new Error("client not found");
  const realm = (client as any).qbo_realm_id as string;
  console.log(bold(`\n=== ${(client as any).client_name} — realm ${realm} ===\n`));

  const token = await getValidToken(CLIENT_LINK_ID, supa);

  // 1. What the matcher's UF lookup resolves to
  const ufId = await findUndepositedFundsAccountId(realm, token);
  console.log(bold("1. findUndepositedFundsAccountId() →"), ufId ? green(ufId) : red("null (NO UF ACCOUNT MATCHED subtype=UndepositedFunds)"));

  // 2. All Other Current Asset accounts (spot a UF acct with wrong subtype)
  const acctData = await q(realm, token, "SELECT Id, Name, AccountType, AccountSubType, CurrentBalance FROM Account WHERE Active = true");
  const accts: any[] = acctData?.QueryResponse?.Account || [];
  console.log(bold("\n2. Accounts that look like UF / A/R:"));
  for (const a of accts) {
    const name = String(a.Name || "");
    if (/undeposited|receivable|a\/r|clearing|holding/i.test(name) || a.AccountSubType === "UndepositedFunds") {
      const flag = a.AccountSubType === "UndepositedFunds" ? green(" [matcher UF target]") : "";
      console.log(`   ${a.Id.padStart(4)}  ${name.padEnd(38)} type=${a.AccountType} sub=${a.AccountSubType} bal=${usd(Number(a.CurrentBalance || 0))}${flag}`);
    }
  }

  // 3. Payments deposited to UF (what the matcher pulls)
  const ufPayments = ufId ? await fetchUndepositedFundsPayments(realm, token, ufId) : [];
  const ufSum = ufPayments.reduce((s, p) => s + p.amount, 0);
  const applied = ufPayments.filter((p) => p.already_applied).length;
  console.log(bold("\n3. Payments deposited to UF (matcher input):"));
  console.log(`   count=${ufPayments.length}  sum=${usd(ufSum)}  already_applied(excluded)=${applied}`);

  // 3b. Raw payment query regardless of UF id, to see if Payments even exist
  if (ufId) {
    const rawPay = await q(realm, token, `SELECT COUNT(*) FROM Payment WHERE DepositToAccountRef = '${ufId}'`);
    console.log(dim(`   raw COUNT Payment WHERE DepositToAccountRef='${ufId}' → ${rawPay?.QueryResponse?.totalCount ?? "?"}`));
  }

  // 4. SalesReceipts deposited to UF — the matcher does NOT look at these today
  if (ufId) {
    const srData = await q(realm, token, `SELECT * FROM SalesReceipt WHERE DepositToAccountRef = '${ufId}' MAXRESULTS 1000`);
    const srs: any[] = srData?.QueryResponse?.SalesReceipt || [];
    const srSum = srs.reduce((s, r) => s + Number(r.TotalAmt || 0), 0);
    console.log(bold("\n4. SalesReceipts deposited to UF (MISSED by matcher today):"));
    console.log(`   count=${srs.length}  sum=${usd(srSum)}`);
  }

  // 5. Open invoices (A/R candidates)
  const invoices = await fetchOpenInvoices(realm, token);
  const invSum = invoices.reduce((s, i) => s + i.balance, 0);
  console.log(bold("\n5. Open invoices (A/R candidates):"));
  console.log(`   count=${invoices.length}  open balance sum=${usd(invSum)}`);

  // 6. Matcher breakdown
  const matches = matchUFtoAR(ufPayments, invoices);
  const byKind: Record<string, number> = {};
  for (const m of matches) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
  console.log(bold("\n6. matchUFtoAR() result breakdown:"));
  console.log(`   total results=${matches.length}`, byKind);

  console.log(bold("\n=== DIAGNOSIS ==="));
  if (!ufId) {
    console.log(red("→ UF account lookup returned null. The client's Undeposited Funds account is not AccountSubType='UndepositedFunds'. Fix: resolve UF by name/balance, not just subtype."));
  } else if (ufPayments.length === 0) {
    console.log(yellow("→ UF account found but ZERO Payment records deposited to it. The $338k UF balance is built from SalesReceipts / Deposits / JEs, which the Payment-only query misses. Fix: also pull SalesReceipts (and surface deposits)."));
  } else if (matches.length === 0) {
    console.log(yellow("→ UF payments exist but matcher produced nothing — inspect amounts/customers."));
  } else {
    console.log(green(`→ Matcher produced ${matches.length} results; they should appear across the review tabs by confidence.`));
  }
  console.log();
}

main().catch((e) => {
  console.error(red(String(e?.stack || e)));
  process.exit(1);
});
