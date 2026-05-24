/**
 * Undeposited Funds Audit
 * ========================
 *
 * Finds Receive-Payment entries posted to UF that have no corresponding
 * deposit — i.e. the money never landed in any bank account.
 *
 * Classification uses QBO's OWN LinkedTxn data (more reliable than
 * amount matching):
 *
 *   matched  — the Payment has a LinkedTxn pointing at a Deposit (the
 *              "Make Deposit" step was completed). Already correctly
 *              recorded; nothing to do.
 *   orphan   — no Deposit LinkedTxn. The money never deposited, or
 *              the deposit was recorded as a separate bank-feed line
 *              that categorized directly to income (double-count).
 *
 * Orphan resolutions, picked by the bookkeeper:
 *   owner_draw          — cash went to the owner. JE: Dr Owner Draw, Cr UF
 *   write_off           — payment wasn't real (credit memo, error). JE: Dr Bad Debt/etc, Cr UF
 *   duplicate_recategorize — a deposit DID exist but was miscategorized.
 *                            Bookkeeper finds + re-categorizes in QBO directly;
 *                            we just record it as resolved.
 *   ask_client          — queue for confirmation email
 *   manual_investigation — flag, do nothing automated
 */

import { qboRateLimiter, type QBOAccount } from "./qbo";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/${realmId}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO API ${res.status} on ${endpoint}: ${body}`);
  }
  return res.json();
}

export interface UFAuditPayment {
  qbo_payment_id: string;
  qbo_payment_txn_type: string;     // "Payment" or "SalesReceipt"
  payment_date: string;             // YYYY-MM-DD
  payment_amount: number;
  customer_qbo_id: string | null;
  customer_name: string | null;
  payment_memo: string;
  applied_invoice_ids: string[];

  classification: "matched" | "orphan";
  matched_deposit_id: string | null;
  matched_deposit_date: string | null;
  matched_deposit_amount: number | null;
  matched_deposit_bank_account: string | null;
}

export interface UfAuditScanResult {
  uf_account_qbo_id: string;
  uf_account_name: string;
  uf_account_current_balance: number;
  scan_from: string;
  scan_to: string;
  payments_total: number;
  matched_count: number;
  orphan_count: number;
  total_uf_balance: number;
  total_orphan_amount: number;
  payments: UFAuditPayment[];
}

/**
 * Full UF audit scan. Pulls every Payment posted to the UF account,
 * then classifies via LinkedTxn data.
 */
export async function scanUfAudit(
  realmId: string,
  accessToken: string,
  ufAccountId: string,
  options?: { lookbackDays?: number }
): Promise<UfAuditScanResult> {
  // Lookback window. Defaults to 1825 days (5 years) — UF orphans can be
  // VERY old (years of unrecorded deposits accumulate). 2 years was too
  // tight for messes that pre-date our engagement.
  const lookbackDays = options?.lookbackDays ?? 1825;
  const since = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Pull the UF account itself so we can show name + current balance in the
  // results UI. Critical for the "scan returned 0 but UF balance is $338K"
  // diagnostic — without this, the bookkeeper can't tell if the picker
  // grabbed the wrong account or if the entries are non-Payment.
  let ufAccountName = "Undeposited Funds";
  let ufAccountCurrentBalance = 0;
  try {
    const acctQuery = encodeURIComponent(
      `SELECT Id, Name, CurrentBalance FROM Account WHERE Id = '${ufAccountId}'`
    );
    const acctData = await qboRequest<any>(realmId, accessToken, `/query?query=${acctQuery}`);
    const acctRow = acctData?.QueryResponse?.Account?.[0];
    if (acctRow) {
      ufAccountName = String(acctRow.Name || ufAccountName);
      ufAccountCurrentBalance = Number(acctRow.CurrentBalance || 0);
    }
  } catch (err: any) {
    console.warn("[uf-audit] UF account lookup failed:", err?.message);
  }

  // Helper to fetch a paginated query
  async function fetchAllPayments(table: "Payment" | "SalesReceipt") {
    const out: any[] = [];
    let page = 0;
    const pageSize = 200; // QBO max is 1000 but smaller pages → snappier first-byte
    while (true) {
      const startPosition = page * pageSize + 1;
      const query = encodeURIComponent(
        `SELECT * FROM ${table} WHERE DepositToAccountRef = '${ufAccountId}' AND TxnDate >= '${since}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
      );
      let data: any;
      try {
        data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
      } catch (err: any) {
        console.warn(`[uf-audit] ${table} query failed:`, err?.message);
        break;
      }
      const rows: any[] = data?.QueryResponse?.[table] || [];
      out.push(...rows);
      if (rows.length < pageSize) break;
      page++;
      if (page > 50) break; // safety cap — 10k records is more than enough
    }
    return out;
  }

  // Pull both Payment AND SalesReceipt — both can deposit to UF.
  const [paymentRows, salesReceiptRows] = await Promise.all([
    fetchAllPayments("Payment"),
    fetchAllPayments("SalesReceipt"),
  ]);

  // Collect every deposit linked from these payments so we can fetch the
  // deposit's bank account context for the matched_deposit_bank_account
  // column.
  const depositIdsToFetch = new Set<string>();
  for (const row of [...paymentRows, ...salesReceiptRows]) {
    const linkedFromLines: any[] = (row.Line || []).flatMap((l: any) => l.LinkedTxn || []);
    for (const lt of [...(row.LinkedTxn || []), ...linkedFromLines]) {
      if (lt?.TxnType === "Deposit" && lt?.TxnId) depositIdsToFetch.add(String(lt.TxnId));
    }
  }

  // Fetch deposit details so we can attribute bank account / date.
  const depositById = new Map<string, any>();
  if (depositIdsToFetch.size > 0) {
    // Batch via SELECT WHERE Id IN (...). QBO supports up to ~250 IDs per IN.
    const ids = Array.from(depositIdsToFetch);
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const inClause = batch.map((id) => `'${id}'`).join(",");
      const query = encodeURIComponent(`SELECT * FROM Deposit WHERE Id IN (${inClause})`);
      try {
        const data: any = await qboRequest<any>(
          realmId,
          accessToken,
          `/query?query=${query}`
        );
        const rows: any[] = data?.QueryResponse?.Deposit || [];
        for (const d of rows) depositById.set(String(d.Id), d);
      } catch (err: any) {
        console.warn("[uf-audit] Deposit query failed:", err?.message);
      }
    }
  }

  // Build the classified list
  const payments: UFAuditPayment[] = [];
  let totalUfBalance = 0;
  let totalOrphanAmount = 0;

  function classify(row: any, txnType: "Payment" | "SalesReceipt"): UFAuditPayment {
    const linkedFromLines: any[] = (row.Line || []).flatMap((l: any) => l.LinkedTxn || []);
    const allLinked = [...(row.LinkedTxn || []), ...linkedFromLines];
    const depositLink = allLinked.find((l: any) => l?.TxnType === "Deposit" && l?.TxnId);

    const appliedInvoiceIds = allLinked
      .filter((l: any) => l?.TxnType === "Invoice" && l?.TxnId)
      .map((l: any) => String(l.TxnId));

    const amount = Number(row.TotalAmt || 0);
    const isMatched = !!depositLink;
    const deposit = depositLink ? depositById.get(String(depositLink.TxnId)) : null;

    // Find the bank account from the Deposit's DepositToAccountRef
    let depositBankAccount: string | null = null;
    if (deposit) {
      depositBankAccount =
        deposit?.DepositToAccountRef?.name ||
        deposit?.DepositToAccountRef?.value ||
        null;
    }

    return {
      qbo_payment_id: String(row.Id),
      qbo_payment_txn_type: txnType,
      payment_date: String(row.TxnDate || ""),
      payment_amount: amount,
      customer_qbo_id: row.CustomerRef?.value || null,
      customer_name: row.CustomerRef?.name || null,
      payment_memo: String(row.PrivateNote || ""),
      applied_invoice_ids: appliedInvoiceIds,
      classification: isMatched ? "matched" : "orphan",
      matched_deposit_id: depositLink ? String(depositLink.TxnId) : null,
      matched_deposit_date: deposit?.TxnDate || null,
      matched_deposit_amount: deposit ? Number(deposit.TotalAmt || 0) : null,
      matched_deposit_bank_account: depositBankAccount,
    };
  }

  for (const row of paymentRows) {
    const p = classify(row, "Payment");
    payments.push(p);
    totalUfBalance += p.payment_amount;
    if (p.classification === "orphan") totalOrphanAmount += p.payment_amount;
  }
  for (const row of salesReceiptRows) {
    const p = classify(row, "SalesReceipt");
    payments.push(p);
    totalUfBalance += p.payment_amount;
    if (p.classification === "orphan") totalOrphanAmount += p.payment_amount;
  }

  const matchedCount = payments.filter((p) => p.classification === "matched").length;
  const orphanCount = payments.length - matchedCount;

  // Sort orphans first (so the UI can display them at the top), then by
  // customer name then date desc.
  payments.sort((a, b) => {
    if (a.classification !== b.classification) {
      return a.classification === "orphan" ? -1 : 1;
    }
    const cmp = (a.customer_name || "").localeCompare(b.customer_name || "");
    if (cmp !== 0) return cmp;
    return b.payment_date.localeCompare(a.payment_date);
  });

  return {
    uf_account_qbo_id: ufAccountId,
    uf_account_name: ufAccountName,
    uf_account_current_balance: Math.round(ufAccountCurrentBalance * 100) / 100,
    scan_from: since,
    scan_to: new Date().toISOString().slice(0, 10),
    payments_total: payments.length,
    matched_count: matchedCount,
    orphan_count: orphanCount,
    total_uf_balance: Math.round(totalUfBalance * 100) / 100,
    total_orphan_amount: Math.round(totalOrphanAmount * 100) / 100,
    payments,
  };
}

/**
 * Group orphan payments by customer for the "fix everyone from this customer
 * with one JE" workflow. Returns the count, total amount, and earliest/latest
 * payment date per group.
 */
export interface OrphanGroup {
  customer_name: string;
  customer_qbo_id: string | null;
  count: number;
  total_amount: number;
  earliest_date: string;
  latest_date: string;
  payment_ids: string[];
}

export function groupOrphansByCustomer(
  payments: UFAuditPayment[]
): OrphanGroup[] {
  const orphans = payments.filter((p) => p.classification === "orphan");
  const byCustomer = new Map<string, OrphanGroup>();
  for (const p of orphans) {
    const key = p.customer_qbo_id || `__name:${p.customer_name || "(no customer)"}`;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        customer_name: p.customer_name || "(no customer)",
        customer_qbo_id: p.customer_qbo_id,
        count: 0,
        total_amount: 0,
        earliest_date: p.payment_date,
        latest_date: p.payment_date,
        payment_ids: [],
      });
    }
    const g = byCustomer.get(key)!;
    g.count += 1;
    g.total_amount += p.payment_amount;
    g.payment_ids.push(p.qbo_payment_id);
    if (p.payment_date < g.earliest_date) g.earliest_date = p.payment_date;
    if (p.payment_date > g.latest_date) g.latest_date = p.payment_date;
  }
  // Sort by total descending
  const groups = Array.from(byCustomer.values()).sort(
    (a, b) => b.total_amount - a.total_amount
  );
  for (const g of groups) g.total_amount = Math.round(g.total_amount * 100) / 100;
  return groups;
}

/**
 * Find the best "target" equity-type account for an Owner Draw resolution.
 * Prefers an existing account matching name patterns; bookkeeper can still
 * override in the UI.
 */
export function findOwnerDrawAccount(allAccounts: QBOAccount[]): QBOAccount | null {
  const candidates = allAccounts.filter(
    (a) => a.Active !== false && a.AccountType === "Equity"
  );
  // Prefer explicit "Owner's Draw" / "Owner Draws"
  for (const re of [/owner.?s?\s+draw/i, /\bdraws?\b/i, /distributions?/i, /shareholder/i]) {
    const hit = candidates.find((a) => re.test(a.Name));
    if (hit) return hit;
  }
  return null;
}
