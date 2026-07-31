import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboRequest, qboErrorResponse } from "@/lib/qbo";
import {
  extractUnappliedPayments,
  extractOpenInvoices,
  buildUcpiItems,
} from "@/lib/ucpi-resolution";
import { auditClient } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/ucpi/scan   (READ-ONLY against QBO)
 *   { period?: "YYYY-MM", start?: "YYYY-MM-DD", end?: "YYYY-MM-DD" }
 *
 * THE MISSING FIRST LINK. `lib/ucpi-resolution.ts` could always find unapplied
 * payments, match them to open invoices and plan a resolution; the routes could
 * always record a client's answers and execute against QBO. But nothing ever
 * created a question — measured 2026-07-31, `ucpi_resolutions` held 0 rows
 * fleet-wide since migration 144, because no code inserted into it. The chain
 * was [nothing] → answer → resolve. This is the [nothing].
 *
 * WHY IT MATTERS. Money a customer paid that was never applied to an invoice
 * sits in Unapplied Cash Payment Income — revenue QBO can't attribute, and an
 * invoice left open inflating A/R. RocketPainter Kingston shows $1,095 of it on
 * the P&L right now. SNAP had every part needed to fix that except the part that
 * notices it.
 *
 * Read-only: no QBO writes here at all. It only creates the questions. Applying
 * anything is /ucpi/[resolutionId]/resolve, which is dry-run by default.
 *
 * Idempotent per (client, period): a re-scan replaces PENDING rows and never
 * touches ones already answered or resolved, so re-running mid-month can't
 * discard a client's answer.
 */

/** Paged QBO entity fetch. Payments have no per-period filter worth trusting —
 *  an unapplied payment from March is still unapplied in July — so the window
 *  bounds the txn date only, and defaults to the current year. */
async function fetchPaymentsInWindow(
  realmId: string,
  accessToken: string,
  start: string,
  end: string
): Promise<any[]> {
  const out: any[] = [];
  const pageSize = 500;
  for (let page = 0; page < 40; page++) {
    const startPosition = page * pageSize + 1;
    const q = encodeURIComponent(
      `SELECT * FROM Payment WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' ` +
        `STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const data: any = await qboRequest<any>(realmId, accessToken, `/query?query=${q}`);
    const rows: any[] = data?.QueryResponse?.Payment || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function fetchAllOpenInvoices(realmId: string, accessToken: string): Promise<any[]> {
  const out: any[] = [];
  const pageSize = 500;
  for (let page = 0; page < 40; page++) {
    const startPosition = page * pageSize + 1;
    const q = encodeURIComponent(
      `SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const data: any = await qboRequest<any>(realmId, accessToken, `/query?query=${q}`);
    const rows: any[] = data?.QueryResponse?.Invoice || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await (service as any)
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead", "bookkeeper"].includes(String((actor as any)?.role || ""))) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const { id: clientLinkId } = await ctx.params;
  const body = await request.json().catch(() => ({} as any));

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json(
      { error: "Client not found, inactive, or not connected to QuickBooks" },
      { status: 400 }
    );
  }

  const year = new Date().getUTCFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start) ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end) ? body.end : new Date().toISOString().slice(0, 10);
  const period = /^\d{4}-\d{2}$/.test(body.period) ? body.period : end.slice(0, 7);

  try {
    const token = await getValidToken(
      clientLinkId,
      service as any,
      "ironbooks/api/clients/ucpi/scan"
    );
    const realm = String((client as any).qbo_realm_id);

    const [rawPayments, rawInvoices] = await Promise.all([
      fetchPaymentsInWindow(realm, token, start, end),
      fetchAllOpenInvoices(realm, token),
    ]);

    const payments = extractUnappliedPayments(rawPayments);
    const openInvoices = extractOpenInvoices(rawInvoices).map((inv, i) => ({
      ...inv,
      customer_id: (rawInvoices[i] as any)?.CustomerRef?.value
        ? String((rawInvoices[i] as any).CustomerRef.value)
        : null,
    }));
    const items = buildUcpiItems(payments, openInvoices);

    // ── Persist, without clobbering a client's work ────────────────────────
    // Only PENDING rows for this period are replaced. Anything answered or
    // resolved is left exactly as it is — a re-scan must never throw away an
    // answer the client already gave us.
    const { data: existing } = await (service as any)
      .from("ucpi_resolutions")
      .select("id, customer_id, status")
      .eq("client_link_id", clientLinkId)
      .eq("period", period);

    const keep = new Set(
      ((existing as any[]) || [])
        .filter((r) => r.status !== "pending")
        .map((r) => String(r.customer_id ?? ""))
    );
    const stalePendingIds = ((existing as any[]) || [])
      .filter((r) => r.status === "pending")
      .map((r) => r.id);
    if (stalePendingIds.length) {
      await (service as any).from("ucpi_resolutions").delete().in("id", stalePendingIds);
    }

    const rows = items
      .filter((it) => !keep.has(String(it.customer_id ?? "")))
      .map((it) => ({
        client_link_id: clientLinkId,
        period,
        customer: it.customer,
        customer_id: it.customer_id,
        payment_ids: it.payments.map((p) => p.payment_id),
        unapplied_amount: it.unapplied_total,
        open_invoices: it.open_invoices as any,
        status: "pending",
      }));

    let inserted = 0;
    if (rows.length) {
      const { error, count } = await (service as any)
        .from("ucpi_resolutions")
        .insert(rows, { count: "exact" });
      if (error) throw new Error(`Could not save UCPI questions: ${error.message}`);
      inserted = count ?? rows.length;
    }

    const unappliedTotal =
      Math.round(items.reduce((s, it) => s + it.unapplied_total, 0) * 100) / 100;

    await auditClient(service, {
      eventType: "ucpi_scan",
      clientLinkId,
      userId: user.id,
      payload: {
        period,
        window: { start, end },
        payments_scanned: rawPayments.length,
        unapplied_payments: payments.length,
        open_invoices: openInvoices.length,
        customers_with_unapplied: items.length,
        unapplied_total: unappliedTotal,
        questions_created: inserted,
        preserved_answered: keep.size,
      },
    });

    return NextResponse.json({
      ok: true,
      client: { id: clientLinkId, name: (client as any).client_name },
      period,
      window: { start, end },
      scanned: { payments: rawPayments.length, open_invoices: openInvoices.length },
      unapplied: {
        payments: payments.length,
        customers: items.length,
        total: unappliedTotal,
      },
      questions_created: inserted,
      preserved_answered: keep.size,
      items: items.map((it) => ({
        customer: it.customer,
        unapplied_total: it.unapplied_total,
        payments: it.payments.length,
        open_invoices: it.open_invoices.length,
        // The whole point of the two-question flow: with an open invoice we can
        // propose applying it; without one we have to ask whether the money was
        // even earned yet, because it may be a customer deposit (a liability).
        has_open_invoices: it.has_open_invoices,
      })),
      note:
        "Read-only scan — no QuickBooks writes. Each customer with unapplied cash becomes a " +
        "question; answering it (collected? earned or deposit?) produces the plan, and " +
        "/ucpi/[id]/resolve executes it, dry-run by default.",
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
