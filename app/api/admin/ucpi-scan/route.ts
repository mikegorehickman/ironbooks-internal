import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboRequest, qboErrorResponse } from "@/lib/qbo";
import { extractUnappliedPayments, buildUcpiItems, type UcpiOpenInvoice } from "@/lib/ucpi-resolution";

/**
 * POST /api/admin/ucpi-scan   { client_link_id, start?, end? }   (READ-ONLY)
 *
 * Locates a client's Unapplied Cash Payment Income: the customer Payments
 * carrying an unapplied balance (parked on QBO's UCPI account), grouped by
 * customer with each customer's OPEN invoices attached as apply-candidates.
 * Feeds the bookkeeper review + the post-delivery client question. No writes.
 * Admin / lead.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const q = (stmt: string) => `/query?query=${encodeURIComponent(stmt)}`;

// Page a QBO entity query (STARTPOSITION/MAXRESULTS) to completion.
async function fetchAll(realm: string, token: string, entity: string, where: string): Promise<any[]> {
  const out: any[] = [];
  let startPos = 1;
  const pageSize = 1000;
  for (let page = 0; page < 20; page++) {
    const data = await qboRequest<any>(realm, token, q(`SELECT * FROM ${entity} ${where} STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`));
    const batch: any[] = data?.QueryResponse?.[entity] || [];
    out.push(...batch);
    if (batch.length < pageSize) break;
    startPos += pageSize;
  }
  return out;
}

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || "") ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end || "") ? body.end : new Date().toISOString().slice(0, 10);

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!(client as any)?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);

    // Payments in the window + every open invoice (open balance can pre-date
    // the window, so invoices aren't date-filtered — just Balance > 0).
    const [rawPayments, rawInvoices] = await Promise.all([
      fetchAll(realm, token, "Payment", `WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'`),
      fetchAll(realm, token, "Invoice", `WHERE Balance > '0'`),
    ]);

    const payments = extractUnappliedPayments(rawPayments);
    const openInvoices: (UcpiOpenInvoice & { customer_id: string | null })[] = rawInvoices
      .filter((i) => Number(i?.Balance) > 0.005)
      .map((i) => ({
        invoice_id: String(i.Id),
        doc_number: i?.DocNumber ?? null,
        date: i?.TxnDate || "",
        balance: r2(i?.Balance),
        total: r2(i?.TotalAmt),
        customer_id: i?.CustomerRef?.value != null ? String(i.CustomerRef.value) : null,
      }));

    const items = buildUcpiItems(payments, openInvoices);
    const unappliedTotal = r2(items.reduce((s, it) => s + it.unapplied_total, 0));

    return NextResponse.json({
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      window: { start, end },
      count: items.length,
      unapplied_total: unappliedTotal,
      items,
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
