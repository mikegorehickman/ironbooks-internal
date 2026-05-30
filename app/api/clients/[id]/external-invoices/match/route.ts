import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { fetchInvoicesForRange } from "@/lib/qbo-stripe-recon";
import { matchInvoices, type QboInvoice } from "@/lib/external-invoices/match";
import type { ParsedRow } from "@/lib/external-invoices/parse";

/**
 * GET /api/clients/[id]/external-invoices/match
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Runs the QBO ↔ external-CSV match for the client and returns the
 * lineage-aware gap analysis the BS Cleanup UI consumes:
 *   - matched:        QBO invoices linked to a CSV row, with confidence
 *   - unmatched_qbo:  QBO invoices with no CSV record (manual or sync drift)
 *   - buckets:        per-job/proposal counts (QBO vs CSV) — the lineage
 *                     bucket with delta > 0 is the "estimate revision /
 *                     change-order" case that today's gap analyzer
 *                     misclassifies as "duplicate"
 *
 * Date range bounds the QBO Invoice query. Defaults to last 24 months.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const start = url.searchParams.get("start") || defaultStart();
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

  const service = createServiceSupabase();

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, qbo_realm_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const realmId = (clientLink as any).qbo_realm_id as string;

  // Pull CSV rows for this client (both sources combined). Matching engine
  // doesn't care which source — it just uses lineage_key.
  const { data: csvRowsRaw } = await (service as any)
    .from("external_invoice_rows")
    .select("id, customer_name, customer_name_normalized, lineage_key, external_invoice_id, row_type, amount, issue_date, status, source")
    .eq("client_link_id", clientLinkId)
    .eq("row_type", "invoice");

  const csvRows: ParsedRow[] = ((csvRowsRaw as any[]) || []).map((r) => ({
    customer_name: r.customer_name || "",
    customer_name_normalized: r.customer_name_normalized || "",
    lineage_key: r.lineage_key,
    external_invoice_id: r.external_invoice_id,
    row_type: r.row_type,
    amount: r.amount == null ? null : Number(r.amount),
    issue_date: r.issue_date,
    status: r.status,
    raw_row: {},
  }));

  // Fetch QBO invoices in the requested date range. fetchInvoicesForRange
  // already widens by 30 days each side, so we don't pre-widen here.
  let qboInvoices: QboInvoice[] = [];
  let qboError: string | null = null;
  if (realmId) {
    try {
      const token = await getValidToken(clientLinkId, service as any);
      const live = await fetchInvoicesForRange(realmId, token, start, end);
      // Map the stripe-recon shape to the matcher's minimal QboInvoice shape.
      qboInvoices = live.map((inv: any) => ({
        Id: String(inv.Id),
        DocNumber: inv.DocNumber || null,
        CustomerRef: inv.CustomerRef
          ? { value: String(inv.CustomerRef.value), name: inv.CustomerRef.name }
          : null,
        TotalAmt: typeof inv.TotalAmt === "number" ? inv.TotalAmt : Number(inv.TotalAmt) || null,
        TxnDate: inv.TxnDate || null,
        PrivateNote: inv.PrivateNote || null,
        CustomerMemo: inv.CustomerMemo || null,
      }));
    } catch (err: any) {
      qboError = err?.message || String(err);
    }
  }

  const analysis = matchInvoices(qboInvoices, csvRows);

  return NextResponse.json({
    client_link_id: clientLinkId,
    client_name: (clientLink as any).client_name,
    range: { start, end },
    qbo_invoice_count: qboInvoices.length,
    csv_invoice_count: csvRows.length,
    qbo_error: qboError, // null on success; populated if QBO call failed (fail-soft)
    analysis,
  });
}

function defaultStart(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 2);
  return d.toISOString().slice(0, 10);
}
