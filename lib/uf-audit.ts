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
import { matchOrphansToDeposits, type DepositRow } from "./uf-deposit-match";

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
  payment_ref_num: string | null;     // check # / reference (PaymentRefNum)
  applied_invoice_ids: string[];

  classification: "matched" | "orphan";
  matched_deposit_id: string | null;
  matched_deposit_date: string | null;
  matched_deposit_amount: number | null;
  matched_deposit_bank_account: string | null;

  // Duplicate-detection metadata (set by detectDuplicates). When
  // suspected_duplicate is true, the scanner auto-recommends void_duplicate.
  suspected_duplicate: boolean;
  duplicate_of_payment_id: string | null;
  duplicate_reason: string | null;

  // Smart deposit match (orphans only, set by matchOrphansToDeposits). When an
  // orphan's amount ties out to a real bank deposit (exact / bundled / CA
  // tax-adjusted), the money DID land — surface the deposit so it's resolved,
  // not treated as missing. Suggestion only; no write.
  probable_deposit_id: string | null;
  probable_deposit_date: string | null;
  probable_deposit_amount: number | null;
  probable_deposit_bank: string | null;
  probable_match_kind: "exact" | "combination" | "tax_adjusted" | "tax_combination" | null;
  probable_match_confidence: number | null;
  probable_match_note: string | null;
  /** The other payment ids sharing this deposit (bundled deposit). */
  probable_match_group: string[];
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
  /** Orphans whose amount ties out to a real bank deposit (probable, unlinked). */
  probable_deposited_count: number;
  probable_deposited_amount: number;
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
  options?: { lookbackDays?: number; region?: "CA" | "US" }
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

  // Helper to fetch a paginated query.
  //
  // IMPORTANT: QBO does NOT allow filtering Payment/SalesReceipt by
  // DepositToAccountRef — `WHERE DepositToAccountRef = '24'` returns a 400
  // ("property 'DepositToAccountRef' is not queryable") or a 503 SystemFault.
  // That invalid clause was silently failing every scan and returning zero
  // rows (the "scan found 0 but UF balance is $338K" symptom). TxnDate IS
  // queryable, so we filter by date in the query and gate on the UF account
  // client-side — DepositToAccountRef is present on each returned object.
  async function fetchAllPayments(table: "Payment" | "SalesReceipt") {
    const out: any[] = [];
    let page = 0;
    const pageSize = 200; // QBO max is 1000 but smaller pages → snappier first-byte
    while (true) {
      const startPosition = page * pageSize + 1;
      const query = encodeURIComponent(
        `SELECT * FROM ${table} WHERE TxnDate >= '${since}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
      );
      let data: any;
      try {
        data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
      } catch (err: any) {
        console.warn(`[uf-audit] ${table} query failed:`, err?.message);
        break;
      }
      const rows: any[] = data?.QueryResponse?.[table] || [];
      // Client-side gate: only rows deposited into the UF account.
      for (const row of rows) {
        if (row.DepositToAccountRef?.value === ufAccountId) out.push(row);
      }
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
      payment_ref_num: row.PaymentRefNum ? String(row.PaymentRefNum) : null,
      applied_invoice_ids: appliedInvoiceIds,
      classification: isMatched ? "matched" : "orphan",
      matched_deposit_id: depositLink ? String(depositLink.TxnId) : null,
      matched_deposit_date: deposit?.TxnDate || null,
      matched_deposit_amount: deposit ? Number(deposit.TotalAmt || 0) : null,
      matched_deposit_bank_account: depositBankAccount,
      suspected_duplicate: false,
      duplicate_of_payment_id: null,
      duplicate_reason: null,
      probable_deposit_id: null,
      probable_deposit_date: null,
      probable_deposit_amount: null,
      probable_deposit_bank: null,
      probable_match_kind: null,
      probable_match_confidence: null,
      probable_match_note: null,
      probable_match_group: [],
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

  // Flag suspected duplicates (mutates payments in place). Only orphans get
  // a void recommendation — see detectDuplicates.
  detectDuplicates(payments);

  // ── Smart deposit matching (Mike 2026-07-18) ──
  // An orphan (no Deposit LinkedTxn) may still have landed in the bank as an
  // unlinked deposit. Pull every Deposit in the window and tie orphans out by
  // amount — exact, bundled, or (CA) net-of-GST/HST. Suggestion only; no write.
  let probableDepositedCount = 0;
  let probableDepositedAmount = 0;
  try {
    const deposits = await fetchAllDeposits(realmId, accessToken, since);
    const orphanRows = payments
      .filter((p) => p.classification === "orphan" && !p.suspected_duplicate)
      .map((p) => ({ id: p.qbo_payment_id, date: p.payment_date, amount: p.payment_amount, customer: p.customer_name }));
    const matches = matchOrphansToDeposits(orphanRows, deposits, { region: options?.region === "CA" ? "CA" : "US" });
    const byId = new Map(payments.map((p) => [p.qbo_payment_id, p]));
    for (const m of matches) {
      for (const pid of m.paymentIds) {
        const p = byId.get(pid);
        if (!p) continue;
        p.probable_deposit_id = m.depositId;
        p.probable_deposit_date = m.depositDate;
        p.probable_deposit_amount = m.depositAmount;
        p.probable_deposit_bank = m.bankAccount;
        p.probable_match_kind = m.kind;
        p.probable_match_confidence = m.confidence;
        p.probable_match_note = m.note;
        p.probable_match_group = m.paymentIds.filter((x) => x !== pid);
        probableDepositedCount++;
        probableDepositedAmount += p.payment_amount;
      }
    }
  } catch (err: any) {
    console.warn("[uf-audit] deposit matching failed:", err?.message);
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
    probable_deposited_count: probableDepositedCount,
    probable_deposited_amount: Math.round(probableDepositedAmount * 100) / 100,
    payments,
  };
}

/**
 * Fetch every Deposit in the window (into any bank account) so orphan UF
 * payments can be tied out by amount. Read-only. `since` = YYYY-MM-DD.
 */
async function fetchAllDeposits(
  realmId: string,
  accessToken: string,
  since: string,
): Promise<DepositRow[]> {
  const out: DepositRow[] = [];
  let page = 0;
  const pageSize = 200;
  while (true) {
    const startPosition = page * pageSize + 1;
    const query = encodeURIComponent(
      `SELECT * FROM Deposit WHERE TxnDate >= '${since}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    let data: any;
    try {
      data = await qboRequest<any>(realmId, accessToken, `/query?query=${query}`);
    } catch (err: any) {
      console.warn("[uf-audit] Deposit list query failed:", err?.message);
      break;
    }
    const rows: any[] = data?.QueryResponse?.Deposit || [];
    for (const d of rows) {
      out.push({
        id: String(d.Id),
        date: String(d.TxnDate || ""),
        amount: Number(d.TotalAmt || 0),
        bankAccount: d.DepositToAccountRef?.name || d.DepositToAccountRef?.value || null,
      });
    }
    if (rows.length < pageSize) break;
    page++;
    if (page > 50) break;
  }
  return out;
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

// ─── Duplicate detection ────────────────────────────────────────────────

function normToken(s: string | null): string {
  return (s || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

function daysApart(d1: string, d2: string): number {
  const t1 = new Date(d1 + "T00:00:00Z").getTime();
  const t2 = new Date(d2 + "T00:00:00Z").getTime();
  if (isNaN(t1) || isNaN(t2)) return Infinity;
  return Math.abs(t1 - t2) / 86_400_000;
}

/**
 * Detect suspected-duplicate UF payments and mark the duplicate copies with
 * suspected_duplicate / duplicate_of_payment_id / duplicate_reason (mutates
 * in place). The scan route turns these into an auto-recommended
 * void_duplicate resolution.
 *
 * Two signals (both require an exact dollar-amount match):
 *   1. Same check/reference number (PaymentRefNum) — strongest. Catches the
 *      "same check entered twice" case even when the customer name is spelled
 *      differently (e.g. "Charlson" vs "Charson").
 *   2. Same (fuzzy) customer + amount within 14 days — catches a payment
 *      keyed in twice in quick succession with no check #.
 *
 * Within a duplicate cluster the "original" we KEEP is: a matched (already
 * deposited) copy if one exists, otherwise the earliest-dated copy. Only
 * ORPHAN copies get flagged — we never auto-recommend voiding a payment that
 * was already deposited.
 */
export function detectDuplicates(payments: UFAuditPayment[]): void {
  const byAmount = new Map<number, UFAuditPayment[]>();
  for (const p of payments) {
    const cents = Math.round(p.payment_amount * 100);
    if (cents <= 0) continue;
    if (!byAmount.has(cents)) byAmount.set(cents, []);
    byAmount.get(cents)!.push(p);
  }

  for (const group of byAmount.values()) {
    if (group.length < 2) continue;

    // Union-find over the same-amount group.
    const parent = group.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (a: number, b: number) => {
      parent[find(a)] = find(b);
    };

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const ra = normToken(a.payment_ref_num);
        const rb = normToken(b.payment_ref_num);
        const refMatch = !!ra && !!rb && ra === rb;

        const na = normToken(a.customer_name);
        const nb = normToken(b.customer_name);
        const nameMatch =
          !!na &&
          !!nb &&
          (na === nb ||
            (Math.min(na.length, nb.length) >= 4 && levenshtein(na, nb) <= 2));

        if (refMatch) {
          union(i, j); // same check # + amount: strong, ignore date/name
        } else if (nameMatch && daysApart(a.payment_date, b.payment_date) <= 14) {
          union(i, j);
        }
      }
    }

    const clusters = new Map<number, number[]>();
    for (let i = 0; i < group.length; i++) {
      const r = find(i);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r)!.push(i);
    }

    for (const idxs of clusters.values()) {
      if (idxs.length < 2) continue;
      const members = idxs.map((i) => group[i]);
      // Pick the copy to KEEP: a deposited one if present, else earliest date.
      let original =
        members.find((m) => m.classification === "matched") ||
        members.slice().sort((a, b) => a.payment_date.localeCompare(b.payment_date))[0];

      for (const m of members) {
        if (m === original) continue;
        if (m.classification !== "orphan") continue; // only flag orphans for voiding
        m.suspected_duplicate = true;
        m.duplicate_of_payment_id = original.qbo_payment_id;
        const ra = normToken(m.payment_ref_num);
        const rb = normToken(original.payment_ref_num);
        const depositedNote =
          original.classification === "matched" ? " (already deposited)" : "";
        if (ra && rb && ra === rb) {
          m.duplicate_reason =
            `Same check/ref #${m.payment_ref_num} + amount $${m.payment_amount.toFixed(2)} ` +
            `as payment ${original.qbo_payment_id}${depositedNote}`;
        } else {
          m.duplicate_reason =
            `Same customer "${m.customer_name || "(none)"}" + amount $${m.payment_amount.toFixed(2)} ` +
            `as payment ${original.qbo_payment_id}${depositedNote}`;
        }
      }
    }
  }
}
