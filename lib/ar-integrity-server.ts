/**
 * A/R integrity — the server-side scan for one client.
 *
 * Shared by the per-client route (/api/clients/[id]/ar-integrity, powering the
 * cleanup step-4 verdict) and the fleet sweep (/api/admin/ar-integrity-sweep)
 * so the two can never drift apart. Read-only against QBO — this diagnoses,
 * it never posts.
 *
 * Mirrors the portal's own A/R maths so the verdict matches what the client
 * actually sees: customer-level credits netted out (applyCustomerCredits) and
 * client-dismissed invoices excluded (portal_ar_dismissals).
 */

import { getValidToken } from "./qbo";
import { fetchOpenInvoices } from "./qbo-balance-sheet";
import { fetchProfitAndLoss } from "./qbo-reports";
import { applyCustomerCredits, fetchCustomerNetBalances } from "./portal-data";
import { analyzeArIntegrity, type ArIntegrityReport } from "./ar-integrity";

/** Months of history used for the "A/R vs monthly revenue" ratio. */
const REVENUE_LOOKBACK_MONTHS = 3;

export async function scanClientArIntegrity(
  service: any,
  client: {
    id: string;
    client_name?: string | null;
    qbo_realm_id: string | null;
    fiscal_year_end?: string | null;
    revenue_recognition_mode?: string | null;
  },
  asOf: Date = new Date()
): Promise<ArIntegrityReport> {
  if (!client.qbo_realm_id) throw new Error("Client has no QBO connection");
  const token = await getValidToken(client.id, service);
  const realm = client.qbo_realm_id;

  // Trailing revenue window — whole months ending last month, so a partial
  // current month doesn't drag the average down and inflate the ratio.
  const end = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (REVENUE_LOOKBACK_MONTHS - 1), 1));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  const [rawInvoices, netBalances, dismissalRows, pl] = await Promise.all([
    fetchOpenInvoices(realm, token),
    fetchCustomerNetBalances(realm, token).catch(() => new Map<string, number>()),
    service
      .from("portal_ar_dismissals")
      .select("qbo_invoice_id")
      .eq("client_link_id", client.id)
      .then((r: any) => r.data || [])
      .catch(() => []),
    fetchProfitAndLoss(realm, token, ymd(start), ymd(end)).catch(() => null),
  ]);

  const dismissed = new Set(((dismissalRows as any[]) || []).map((d) => String(d.qbo_invoice_id)));
  const undismissed = (rawInvoices || []).filter((i) => !dismissed.has(String(i.qbo_invoice_id)));
  const invoices = applyCustomerCredits(undismissed, netBalances as Map<string, number>);

  const monthlyRevenue =
    pl && Number.isFinite(pl.totalIncome) && pl.totalIncome > 0
      ? pl.totalIncome / REVENUE_LOOKBACK_MONTHS
      : null;

  return analyzeArIntegrity({
    invoices: invoices.map((i) => ({
      qbo_invoice_id: i.qbo_invoice_id,
      doc_number: i.doc_number,
      customer_name: i.customer_name,
      txn_date: i.txn_date,
      due_date: i.due_date,
      balance: i.balance,
    })),
    monthlyRevenue,
    depositsOnly: client.revenue_recognition_mode === "deposits_only",
    fiscalYearEnd: client.fiscal_year_end ?? null,
    asOf,
  });
}
