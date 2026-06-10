import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * Client-side A/R dismissals — "this isn't actually owed".
 *
 * POST   { qbo_invoice_id, doc_number?, customer_name?, amount?, reason? }
 *        → upsert a dismissal. The Who's Paying page filters the invoice
 *          out server-side on every future load, regardless of QBO state.
 *          Also mirrored into client_communications so the bookkeeper sees
 *          it on /today and can fix the books for real.
 * DELETE { qbo_invoice_id }
 *        → restore (un-dismiss).
 */
export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const invoiceId = String(body.qbo_invoice_id || "").trim();
  if (!invoiceId) {
    return NextResponse.json({ error: "qbo_invoice_id required" }, { status: 400 });
  }
  const docNumber = body.doc_number ? String(body.doc_number).slice(0, 60) : null;
  const customerName = body.customer_name ? String(body.customer_name).slice(0, 200) : null;
  const amount = typeof body.amount === "number" && Number.isFinite(body.amount) ? body.amount : null;
  const reason = body.reason ? String(body.reason).slice(0, 1000) : null;

  const service = createServiceSupabase();
  const { error } = await (service as any)
    .from("portal_ar_dismissals")
    .upsert(
      {
        client_link_id: ctx.clientLinkId,
        qbo_invoice_id: invoiceId,
        doc_number: docNumber,
        customer_name: customerName,
        amount,
        reason,
        dismissed_by: ctx.userId,
      },
      { onConflict: "client_link_id,qbo_invoice_id" }
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Tell the bookkeeper — the books still show this invoice as open in QBO,
  // so someone has to actually void / credit-memo it. Skipped while
  // impersonating so admin test-clicks don't land in the real inbox.
  if (!ctx.impersonating) {
    try {
      await (service as any).from("client_communications").insert({
        client_link_id: ctx.clientLinkId,
        sender_user_id: ctx.userId,
        direction: "from_client",
        kind: "message",
        body: [
          `🚫 Dismissed an invoice from their A/R view — says it isn't actually owed:`,
          `Invoice ${docNumber ? `#${docNumber}` : invoiceId}${customerName ? ` — ${customerName}` : ""}`,
          amount != null ? `Amount: $${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
          reason ? `Reason: ${reason}` : null,
          ``,
          `Still open in QuickBooks — needs a void or credit memo to clear for real.`,
        ]
          .filter((l) => l !== null)
          .join("\n"),
        attachments: [],
      });
    } catch (e) {
      console.warn("[ar-dismissals] comm mirror failed:", e);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const invoiceId = String(body.qbo_invoice_id || "").trim();
  if (!invoiceId) {
    return NextResponse.json({ error: "qbo_invoice_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { error } = await (service as any)
    .from("portal_ar_dismissals")
    .delete()
    .eq("client_link_id", ctx.clientLinkId)
    .eq("qbo_invoice_id", invoiceId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
