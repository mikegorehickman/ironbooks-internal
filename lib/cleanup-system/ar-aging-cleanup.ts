/**
 * AR Aging Cleanup — clear stale open invoices off the aging report.
 *
 * The problem (2026-07-10 ops call): new clients arrive with years of open
 * AR invoices that were long since paid (or never real), tangled with
 * Undeposited Funds and duplicated revenue. Clearing them by hand — Receive
 * Payment per invoice, per customer, posted to a temporary clearing account —
 * took a bookkeeper two full days on one client. This module does Lisa's
 * exact process in bulk:
 *
 *   - IN-SCOPE years (on/after the engagement cutoff): one Receive Payment
 *     per open invoice, dated to the invoice date, deposited to an
 *     "Uncleared Deposits" clearing account. Only a Payment with a LinkedTxn
 *     removes an invoice from the AR Aging Detail report.
 *   - OUT-OF-SCOPE years (before the cutoff): one lump journal entry per
 *     year — debit Uncleared Deposits, credit A/R per customer (QBO requires
 *     a Customer entity on every A/R line). Dated today so filed periods
 *     stay untouched; the memo names the year it writes off.
 *   - Optional deposit-verification CSV (the client's bank deposits): each
 *     in-scope invoice is marked verified when a matching deposit exists,
 *     so unbacked clears stand out as possible phantom revenue.
 *
 * Everything lands as proposed_entries (decision needs_review) and rides the
 * wizard's existing review → attest → execute machinery. Nothing here writes
 * to QBO — execution happens in execute-proposed.ts via qbo-posting.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createProposedEntry } from "./proposed-entries";
import {
  getValidToken,
  fetchAllAccounts,
  createAccount,
  qboRequest,
} from "@/lib/qbo";
import { serializeMeta, type ArAgingClearMeta } from "./entry-meta";

export const AR_CLEARING_ACCOUNT_NAME = "Uncleared Deposits";

/** How close a bank deposit must be to count as verification. */
export const DEPOSIT_MATCH_WINDOW_DAYS = 60;

const round2 = (n: number) => Math.round(n * 100) / 100;
const todayIso = () => new Date().toISOString().slice(0, 10);

export interface ArAgingInvoice {
  id: string;
  doc: string | null;
  date: string; // YYYY-MM-DD
  customerId: string | null;
  customerName: string | null;
  balance: number;
  total: number;
}

export interface ArAgingOptions {
  /** Invoices dated on/after this are in-scope (Receive Payment path).
   *  Default: Jan 1 of the client's billing_start_date year. */
  cutoffDate?: string;
  /** Raw CSV text of the client's bank deposits (date + amount columns). */
  depositCsvText?: string;
}

export interface DepositRow {
  date: string; // YYYY-MM-DD
  amount: number;
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────

/**
 * Tolerant deposits-CSV parser. Finds the date and amount columns by header
 * name (falls back to first-date-looking / first-money-looking column),
 * strips $ and thousands separators, keeps positive amounts only (deposits).
 */
export function parseDepositCsv(text: string): DepositRow[] {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const split = (line: string): string[] => {
    // Handles simple quoted CSV — enough for bank exports.
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const parseDate = (s: string): string | null => {
    const t = s.trim().replace(/"/g, "");
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
    if (m) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    return null;
  };
  const parseMoney = (s: string): number | null => {
    const t = s.replace(/[$,"\s]/g, "");
    if (!t || !/^-?\(?\d+(\.\d+)?\)?$/.test(t)) return null;
    const neg = t.startsWith("(") || t.startsWith("-");
    const n = parseFloat(t.replace(/[()-]/g, ""));
    return isNaN(n) ? null : neg ? -n : n;
  };

  const header = split(lines[0]).map((h) => h.toLowerCase());
  let dateIdx = header.findIndex((h) => /date/.test(h));
  let amtIdx = header.findIndex((h) => /amount|deposit|credit/.test(h));
  const hasHeader = dateIdx >= 0 || amtIdx >= 0;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rows: DepositRow[] = [];
  for (const line of dataLines) {
    const cells = split(line);
    let date: string | null = null;
    let amount: number | null = null;
    if (dateIdx >= 0 && cells[dateIdx] !== undefined) date = parseDate(cells[dateIdx]);
    if (amtIdx >= 0 && cells[amtIdx] !== undefined) amount = parseMoney(cells[amtIdx]);
    // Positional fallback: first parseable date + first parseable money cell.
    if (date === null) {
      for (const c of cells) {
        const d = parseDate(c);
        if (d) { date = d; break; }
      }
    }
    if (amount === null) {
      for (let i = 0; i < cells.length; i++) {
        if (i === dateIdx) continue;
        const n = parseMoney(cells[i]);
        if (n !== null && n !== 0) { amount = n; break; }
      }
    }
    if (date && amount !== null && amount > 0) rows.push({ date, amount: round2(amount) });
  }
  return rows;
}

export interface ScopeSplit {
  inScope: ArAgingInvoice[];
  /** Out-of-scope invoices grouped by calendar year, ascending. */
  outOfScopeByYear: Array<{ year: number; invoices: ArAgingInvoice[]; total: number }>;
  yearTotals: Array<{ year: number; count: number; total: number; inScope: boolean }>;
}

/** Invoices dated ON the cutoff are in-scope. No cutoff → everything in-scope. */
export function splitByScope(invoices: ArAgingInvoice[], cutoffIso: string | null): ScopeSplit {
  const inScope: ArAgingInvoice[] = [];
  const outMap = new Map<number, ArAgingInvoice[]>();
  const totals = new Map<number, { count: number; total: number; inScope: boolean }>();

  for (const inv of invoices) {
    const year = Number((inv.date || "").slice(0, 4)) || 0;
    const isIn = !cutoffIso || inv.date >= cutoffIso;
    const t = totals.get(year) || { count: 0, total: 0, inScope: isIn };
    t.count++;
    t.total = round2(t.total + inv.balance);
    // A year straddling the cutoff counts as in-scope for display.
    t.inScope = t.inScope || isIn;
    totals.set(year, t);

    if (isIn) inScope.push(inv);
    else {
      const arr = outMap.get(year) || [];
      arr.push(inv);
      outMap.set(year, arr);
    }
  }

  const outOfScopeByYear = [...outMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, invs]) => ({
      year,
      invoices: invs,
      total: round2(invs.reduce((s, i) => s + i.balance, 0)),
    }));
  const yearTotals = [...totals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, t]) => ({ year, ...t }));

  return { inScope, outOfScopeByYear, yearTotals };
}

/**
 * Mark invoices verified when a bank deposit matches the open balance within
 * the window. Each deposit verifies at most one invoice (greedy by date
 * proximity) so five identical $500 invoices don't all claim one deposit.
 */
export function matchDepositsToInvoices(
  invoices: ArAgingInvoice[],
  deposits: DepositRow[],
  windowDays = DEPOSIT_MATCH_WINDOW_DAYS
): Set<string> {
  const verified = new Set<string>();
  const used = new Set<number>();
  const dayMs = 86_400_000;

  for (const inv of invoices) {
    const invTime = new Date(inv.date + "T00:00:00Z").getTime();
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < deposits.length; i++) {
      if (used.has(i)) continue;
      if (Math.abs(deposits[i].amount - inv.balance) > 0.01) continue;
      const gap = Math.abs(new Date(deposits[i].date + "T00:00:00Z").getTime() - invTime);
      if (gap <= windowDays * dayMs && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (best >= 0) {
      used.add(best);
      verified.add(inv.id);
    }
  }
  return verified;
}

// ─── QBO reads ───────────────────────────────────────────────────────────

/** All open invoices (Balance > 0), paged. Same data as AR Aging Detail. */
export async function fetchOpenArInvoices(
  realmId: string,
  accessToken: string
): Promise<ArAgingInvoice[]> {
  const out: ArAgingInvoice[] = [];
  let start = 1;
  const page = 500;
  for (;;) {
    const q = encodeURIComponent(
      `SELECT Id, DocNumber, TxnDate, CustomerRef, TotalAmt, Balance FROM Invoice WHERE Balance > '0' STARTPOSITION ${start} MAXRESULTS ${page}`
    );
    const data: any = await qboRequest(realmId, accessToken, `/query?query=${q}`, { method: "GET" });
    const rows: any[] = data?.QueryResponse?.Invoice || [];
    for (const r of rows) {
      out.push({
        id: String(r.Id),
        doc: r.DocNumber ? String(r.DocNumber) : null,
        date: String(r.TxnDate || "").slice(0, 10),
        customerId: r.CustomerRef?.value ? String(r.CustomerRef.value) : null,
        customerName: r.CustomerRef?.name ? String(r.CustomerRef.name) : null,
        balance: round2(Number(r.Balance || 0)),
        total: round2(Number(r.TotalAmt || 0)),
      });
    }
    if (rows.length < page) break;
    start += page;
  }
  return out;
}

/**
 * Resolve the "Uncleared Deposits" clearing account, creating it (Bank type,
 * so it's valid as a Payment's DepositToAccountRef) when missing.
 */
export async function ensureClearingAccount(
  realmId: string,
  accessToken: string
): Promise<{ id: string; name: string; created: boolean }> {
  const accounts = await fetchAllAccounts(realmId, accessToken);
  const existing = accounts.find(
    (a) => a.Active !== false && (a.Name || "").trim().toLowerCase() === AR_CLEARING_ACCOUNT_NAME.toLowerCase()
  );
  if (existing) return { id: String(existing.Id), name: existing.Name, created: false };

  const created = await createAccount(realmId, accessToken, {
    name: AR_CLEARING_ACCOUNT_NAME,
    accountType: "Bank",
    accountSubType: "Checking",
    description:
      "Temporary clearing account for AR aging cleanup — payments received here clear stale open invoices off the aging report. Should trend to zero as cleanup completes.",
  });
  return { id: String(created.Id), name: created.Name, created: true };
}

// ─── The discoverer ──────────────────────────────────────────────────────

export async function discoverArAgingModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  _periodLockDate: string,
  options: ArAgingOptions
): Promise<{ proposed: number }> {
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id, billing_start_date")
    .eq("id", clientLinkId)
    .single();
  const realmId = (client as any)?.qbo_realm_id as string;
  if (!realmId) throw new Error("Client has no QBO connection");
  const accessToken = await getValidToken(clientLinkId, service);

  // Cutoff: explicit option wins; else Jan 1 of the engagement's start year;
  // else no cutoff (everything in-scope).
  let cutoff: string | null = options.cutoffDate || null;
  if (!cutoff) {
    const bsd = (client as any)?.billing_start_date as string | null;
    if (bsd && /^\d{4}/.test(bsd)) cutoff = `${bsd.slice(0, 4)}-01-01`;
  }

  const [invoices, clearing] = await Promise.all([
    fetchOpenArInvoices(realmId, accessToken),
    ensureClearingAccount(realmId, accessToken),
  ]);

  // Find the AR account for the out-of-scope writeoff JE credit lines.
  const accounts = await fetchAllAccounts(realmId, accessToken);
  const arAccount = accounts.find(
    (a) => a.Active !== false && a.AccountType === "Accounts Receivable"
  );

  const deposits = options.depositCsvText ? parseDepositCsv(options.depositCsvText) : [];
  const { inScope, outOfScopeByYear, yearTotals } = splitByScope(invoices, cutoff);
  const verified = deposits.length > 0 ? matchDepositsToInvoices(inScope, deposits) : new Set<string>();

  let proposed = 0;

  // In-scope: one Receive Payment per invoice → clearing account.
  for (const inv of inScope) {
    if (!inv.customerId || inv.balance <= 0) continue;
    const meta: ArAgingClearMeta = {
      v: 1,
      type: "ar_aging_clear",
      invoice_doc: inv.doc,
      customer_id: inv.customerId,
      customer_name: inv.customerName,
      year: Number(inv.date.slice(0, 4)) || 0,
      verified: verified.has(inv.id),
      deposit_rows_uploaded: deposits.length,
    };
    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "ar_aging",
      entryType: "receive_payment",
      amount: inv.balance,
      txnDate: inv.date, // Lisa's practice: payment date = invoice date (BS-only shift, filed P&L untouched)
      memo: `AR aging clear: Invoice ${inv.doc ? `#${inv.doc}` : inv.id} (${inv.customerName || "unknown customer"}, ${inv.date}) $${inv.balance.toFixed(2)} → ${clearing.name}${verified.has(inv.id) ? " — matching bank deposit found" : deposits.length > 0 ? " — NO matching bank deposit (possible phantom revenue, investigate before clearing)" : ""}`,
      qboTransactionId: inv.id,
      qboTransactionType: "Invoice",
      toAccountId: clearing.id,
      toAccountName: clearing.name,
      decisionOverride: "needs_review",
      confidenceOverride: verified.has(inv.id) ? 0.9 : 0.5,
      aiReasoning: serializeMeta(meta),
    });
    proposed++;
  }

  // Out-of-scope: one lump JE per year (debit clearing, credit AR per customer).
  for (const bucket of outOfScopeByYear) {
    if (!arAccount || bucket.total <= 0) continue;
    const byCustomer = new Map<string, { name: string | null; total: number }>();
    for (const inv of bucket.invoices) {
      if (!inv.customerId) continue;
      const c = byCustomer.get(inv.customerId) || { name: inv.customerName, total: 0 };
      c.total = round2(c.total + inv.balance);
      byCustomer.set(inv.customerId, c);
    }
    if (byCustomer.size === 0) continue;
    const jeTotal = round2([...byCustomer.values()].reduce((s, c) => s + c.total, 0));

    const jeLines = [
      {
        side: "debit",
        account_hint: clearing.name,
        qbo_account_id: clearing.id,
        amount: jeTotal,
        description: `Write off ${bucket.year} open AR (pre-engagement)`,
      },
      ...[...byCustomer.entries()].map(([custId, c]) => ({
        side: "credit",
        account_hint: arAccount.Name,
        qbo_account_id: String(arAccount.Id),
        amount: c.total,
        description: `${c.name || custId} — ${bucket.year} open invoices`,
        entity_type: "Customer",
        entity_id: custId,
        entity_name: c.name || undefined,
      })),
    ];

    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "ar_aging",
      entryType: "journal_entry",
      amount: jeTotal,
      txnDate: todayIso(), // dated today so filed periods stay untouched
      memo: `AR aging writeoff — ${bucket.year} pre-engagement open invoices (${bucket.invoices.length} invoices, ${byCustomer.size} customers). One entry per Lisa's process; the invoices remain visible on AR Aging Detail for ${bucket.year} but the balance nets to zero.`,
      jeLines: jeLines as any,
      periodImpact: "clearing_entry",
      decisionOverride: "needs_review",
      confidenceOverride: 0.5,
      aiReasoning: JSON.stringify({
        v: 1,
        type: "ar_aging_writeoff",
        year: bucket.year,
        invoice_count: bucket.invoices.length,
        customer_count: byCustomer.size,
      }),
    });
    proposed++;
  }

  await service
    .from("cleanup_run_modules")
    .update({
      status: "reviewing",
      proposed_count: proposed,
      discovery_notes: {
        cutoff,
        year_totals: yearTotals,
        open_invoices: invoices.length,
        open_total: round2(invoices.reduce((s, i) => s + i.balance, 0)),
        in_scope_count: inScope.length,
        deposit_rows_uploaded: deposits.length,
        verified_count: verified.size,
        clearing_account: clearing.name,
        clearing_account_created: clearing.created,
      },
    } as any)
    .eq("run_id", runId)
    .eq("module", "ar_aging");

  return { proposed };
}
