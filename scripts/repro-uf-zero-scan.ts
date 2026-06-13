// Repro for "0 AR and 0 UF after re-scan" (Clean Cut Painters).
// READ-ONLY against QBO; reads (never writes) the uf_audit_scans table.
//
//   A. Dump the last 5 uf_audit_scans rows — what did the user's actual
//      re-scan record (status, totals, error_message, duration)?
//   B. Run the exact route code path locally: findUndepositedFundsAccountId
//      + scanUfAudit, print totals. If A=0 but B>0, prod is running stale
//      code (deploy issue). If both 0, the lib fix doesn't work.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.QBO_ENVIRONMENT = "production";

import { createClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo";
import { findUndepositedFundsAccountId } from "@/lib/qbo-balance-sheet";
import { scanUfAudit } from "@/lib/uf-audit";

const CLIENT_LINK_ID = "1bc21a0e-7655-4543-9006-97e0eada7130"; // Clean Cut Painters

const supa: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

(async () => {
  console.log("=== A. Last 5 uf_audit_scans rows (what the user's scans recorded) ===");
  const { data: scans } = await supa
    .from("uf_audit_scans")
    .select(
      "id, status, created_at, scan_from, scan_to, uf_account_qbo_id, uf_account_name, uf_account_current_balance, uf_payments_total, matched_count, orphan_count, total_uf_balance, total_orphan_amount, duration_ms, error_message"
    )
    .eq("client_link_id", CLIENT_LINK_ID)
    .order("created_at", { ascending: false })
    .limit(5);
  for (const s of scans || []) {
    console.log(
      `  ${s.created_at}  status=${s.status}  acct=${s.uf_account_qbo_id}(${s.uf_account_name})` +
        ` acctBal=${s.uf_account_current_balance}  payments=${s.uf_payments_total}` +
        ` matched=${s.matched_count} orphans=${s.orphan_count}` +
        ` totalUF=${s.total_uf_balance} orphan$=${s.total_orphan_amount}` +
        ` dur=${s.duration_ms}ms err=${s.error_message || "-"}`
    );
  }

  console.log("\n=== B. Running the route's exact code path locally ===");
  const { data: client } = await supa
    .from("client_links")
    .select("qbo_realm_id, client_name")
    .eq("id", CLIENT_LINK_ID)
    .single();
  const accessToken = await getValidToken(CLIENT_LINK_ID, supa);
  const ufAccountId = await findUndepositedFundsAccountId(client.qbo_realm_id, accessToken);
  console.log(`  UF account id: ${ufAccountId}`);
  const t0 = Date.now();
  const result = await scanUfAudit(client.qbo_realm_id, accessToken, ufAccountId!);
  console.log(
    `  scanUfAudit → payments=${result.payments_total} matched=${result.matched_count}` +
      ` orphans=${result.orphan_count} totalUF=$${result.total_uf_balance}` +
      ` orphan$=$${result.total_orphan_amount} acctBal=$${result.uf_account_current_balance}` +
      ` window=${result.scan_from}→${result.scan_to} in ${Date.now() - t0}ms`
  );
})();
