/**
 * A/R match sessions — the client-assisted leg of the phantom-A/R fix.
 *
 * The scan (lib/ar-integrity) says WHETHER a client's receivables are real;
 * the fleet fixer applies the machine-obvious deposit↔invoice matches. What
 * survives is ambiguity only the client can resolve ("did Starboard actually
 * pay #129?"). This module builds those review items and applies a confirmed
 * match to QBO.
 *
 * Design rules (settled with Mike 2026-07-26):
 *  - CURRENT fiscal year only. Closed-year invoices are prior-period-
 *    adjustment territory (CPA sign-off) and never reach the client.
 *  - The client CONFIRMS machine-proposed candidates; they never free-match.
 *  - Only an exact-eligible candidate (amount matches incl. GST/HST reading,
 *    same customer, invoice not partially paid) may auto-apply, and only when
 *    the session was sent with auto_apply=true. Everything else is a proposal.
 *  - Voids are always human-gated: "not_owed" is a claim, and voiding
 *    destroys information.
 *
 * The QBO write reuses applyDepositToInvoice (lib/crm-invoice-apply): fetch-
 * fresh + stale check, closed-period guard, pre-write snapshot, memo marker.
 */

import { getValidToken, fetchAllAccounts, qboRequest } from "./qbo";
import { fetchOpenInvoices } from "./qbo-balance-sheet";
import { fetchPLDetailAll, fetchProfitAndLoss } from "./qbo-reports";
import {
  analyzeCrmInvoiceRevenue,
  incomeAccountNamesFromSummary,
} from "./crm-invoice-revenue";
import { currentFiscalYearStart } from "./ar-integrity";
import { findArAccount, applyDepositToInvoice } from "./crm-invoice-apply";
import { getCompanyClosingDate } from "./qbo-reclass";

export interface ArMatchCandidate {
  txn_id: string;
  date: string;
  account: string;
  customer: string | null;
  amount: number;
  /** Which tax reading matched the invoice (exact / +5% GST / +13% HST / ~). */
  tax_label: string;
  same_customer: boolean;
  days_apart: number | null;
  /** Safe to auto-apply on client confirm: exact tax reading, same customer,
   *  and the invoice isn't partially paid. */
  exact_eligible: boolean;
}

export interface ArMatchItemDraft {
  qbo_invoice_id: string;
  doc_number: string | null;
  customer_name: string | null;
  txn_date: string;
  amount: number;
  balance: number;
  candidates: ArMatchCandidate[];
}

export interface ClientForMatch {
  id: string;
  client_name?: string | null;
  qbo_realm_id: string | null;
  fiscal_year_end?: string | null;
}

/**
 * Build the review items: every open CURRENT-fiscal-year invoice, each with
 * its machine-proposed candidate deposits (income-account deposits whose
 * amount matches the invoice under an exact / GST / HST reading).
 * Read-only against QBO.
 */
export async function buildArMatchItems(
  service: any,
  client: ClientForMatch,
  asOf: Date = new Date()
): Promise<ArMatchItemDraft[]> {
  if (!client.qbo_realm_id) throw new Error("Client has no QBO connection");
  const realm = client.qbo_realm_id;
  const token = await getValidToken(client.id, service);

  const fyStart = currentFiscalYearStart(client.fiscal_year_end, asOf);
  const end = asOf.toISOString().slice(0, 10);

  const allOpen = await fetchOpenInvoices(realm, token);
  const open = (allOpen || []).filter(
    (i) => (i.balance || 0) > 0.005 && String(i.txn_date || "") >= fyStart
  );
  if (open.length === 0) return [];

  // Candidate deposits come from the same pairing engine the double-count
  // check uses — deposits into income accounts, matched to invoices by
  // amount under exact/GST/HST readings + customer + date proximity.
  const [plSummary, plDetail] = await Promise.all([
    fetchProfitAndLoss(realm, token, fyStart, end, "Cash").catch(() => null),
    fetchPLDetailAll(realm, token, fyStart, end, "Cash"),
  ]);
  const report = analyzeCrmInvoiceRevenue(plDetail, incomeAccountNamesFromSummary(plSummary));

  const pairsByInvoice = new Map<string, ArMatchCandidate[]>();
  for (const p of report.pairs) {
    const invId = String(p.invoice.txn_id);
    const list = pairsByInvoice.get(invId) || [];
    list.push({
      txn_id: String(p.deposit.txn_id),
      date: p.deposit.date,
      account: p.deposit.account,
      customer: p.deposit.customer,
      amount: p.deposit.amount,
      tax_label: p.taxLabel,
      same_customer: p.sameCustomer,
      days_apart: p.daysApart,
      exact_eligible: false, // filled below (needs the invoice balance)
    });
    pairsByInvoice.set(invId, list);
  }

  return open.map((inv) => {
    const candidates = (pairsByInvoice.get(String(inv.qbo_invoice_id)) || [])
      .map((c) => ({
        ...c,
        // Exact-eligible: unambiguous tax reading, same customer, and the
        // invoice is fully unpaid (a partial payment means the deposit can't
        // simply settle it — human judgement required).
        exact_eligible:
          c.same_customer &&
          ["exact", "+5% GST", "+13% HST"].includes(c.tax_label) &&
          Math.abs((inv.balance || 0) - (inv.total_amount || 0)) < 0.01,
      }))
      // Strongest first: exact-eligible, then same-customer, then closest date.
      .sort(
        (a, b) =>
          Number(b.exact_eligible) - Number(a.exact_eligible) ||
          Number(b.same_customer) - Number(a.same_customer) ||
          Math.abs(a.days_apart ?? 999) - Math.abs(b.days_apart ?? 999)
      )
      .slice(0, 5);

    return {
      qbo_invoice_id: String(inv.qbo_invoice_id),
      doc_number: inv.doc_number,
      customer_name: inv.customer_name,
      txn_date: inv.txn_date,
      amount: inv.total_amount,
      balance: inv.balance,
      candidates,
    };
  });
}

export interface ApplyMatchResult {
  ok: boolean;
  outcome: string;
  detail?: string;
}

/**
 * Apply one confirmed match to QBO: repoint the deposit from its income
 * account to A/R + customer so it pays the invoice down — closing the
 * invoice AND removing the double-counted revenue in one move.
 *
 * All guards live in applyDepositToInvoice; this wrapper resolves the
 * inputs (fresh invoice entity, A/R account, closing date) and snapshots
 * to audit_log under ar_match_snapshot.
 */
export async function applyClientMatch(
  service: any,
  client: ClientForMatch,
  item: {
    id: string;
    qbo_invoice_id: string;
    candidates: ArMatchCandidate[];
  },
  depositTxnId: string,
  opts: { dryRun: boolean; actorUserId: string | null }
): Promise<ApplyMatchResult> {
  if (!client.qbo_realm_id) return { ok: false, outcome: "failed", detail: "no QBO connection" };
  const realm = client.qbo_realm_id;

  const candidate = (item.candidates || []).find((c) => String(c.txn_id) === String(depositTxnId));
  if (!candidate) {
    return { ok: false, outcome: "failed", detail: "deposit is not one of this invoice's candidates" };
  }

  const token = await getValidToken(client.id, service);

  // Fresh invoice state — it may have been paid/voided since the session went out.
  let invoice: any;
  try {
    const data = await qboRequest<any>(realm, token, `/invoice/${item.qbo_invoice_id}?minorversion=70`);
    invoice = data?.Invoice;
  } catch (e: any) {
    return { ok: false, outcome: "failed", detail: `invoice fetch: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (!invoice) return { ok: false, outcome: "failed", detail: "invoice not found in QBO" };
  if (Number(invoice.Balance || 0) <= 0.005) {
    return { ok: true, outcome: "already_paid", detail: "invoice balance is already 0 in QBO" };
  }
  const customerId = String(invoice.CustomerRef?.value || "");
  if (!customerId) return { ok: false, outcome: "failed", detail: "invoice has no customer" };

  const accounts = await fetchAllAccounts(realm, token);
  const ar = findArAccount(accounts);
  if (!ar) return { ok: false, outcome: "failed", detail: "no A/R account found in the chart" };

  const closingDate = await getCompanyClosingDate(realm, token).catch(() => null);

  const snapshot = async (kind: string, id: string, entity: any): Promise<void> => {
    await service.from("audit_log").insert({
      event_type: "ar_match_snapshot",
      user_id: opts.actorUserId,
      request_payload: {
        client_link_id: client.id,
        item_id: item.id,
        kind,
        qbo_id: id,
        entity,
      } as any,
    });
  };

  const out = await applyDepositToInvoice({
    realm,
    token,
    invoiceId: String(item.qbo_invoice_id),
    customerId,
    deposit: { txn_id: candidate.txn_id, account: candidate.account, amount: candidate.amount },
    phantomPaymentIds: [], // open invoice — no CRM payment leg to void
    arAccountId: ar.id,
    dryRun: opts.dryRun,
    closingDate,
    snapshot,
  });

  const ok = out.outcome === "applied" || out.outcome === "would_apply";
  return { ok, outcome: out.outcome, detail: (out as any).detail };
}
