import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * Client-side A/P dismissals — "this bill isn't actually owed".
 *
 * POST   { qbo_bill_id, doc_number?, vendor_name?, amount?, reason? }
 *        → upsert a dismissal. The "What you owe" page filters the bill out
 *          server-side on every future load, regardless of QBO state. Also
 *          mirrored into client_communications so the bookkeeper sees it on
 *          /today and can clear it in QuickBooks for real (void / bill credit).
 * DELETE { qbo_bill_id }
 *        → restore (un-dismiss).
 *
 * Mirror of /api/portal/ar-dismissals (invoices).
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
  const billId = String(body.qbo_bill_id || "").trim();
  if (!billId) {
    return NextResponse.json({ error: "qbo_bill_id required" }, { status: 400 });
  }
  const docNumber = body.doc_number ? String(body.doc_number).slice(0, 60) : null;
  const vendorName = body.vendor_name ? String(body.vendor_name).slice(0, 200) : null;
  const amount = typeof body.amount === "number" && Number.isFinite(body.amount) ? body.amount : null;
  const reason = body.reason ? String(body.reason).slice(0, 1000) : null;

  const service = createServiceSupabase();
  const { error } = await (service as any)
    .from("portal_ap_dismissals")
    .upsert(
      {
        client_link_id: ctx.clientLinkId,
        qbo_bill_id: billId,
        doc_number: docNumber,
        vendor_name: vendorName,
        amount,
        reason,
        dismissed_by: ctx.userId,
      },
      { onConflict: "client_link_id,qbo_bill_id" }
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Tell the bookkeeper — the bill still shows as open in QBO, so someone has
  // to actually void it / record a bill credit. Skipped while impersonating so
  // admin test-clicks don't land in the real inbox.
  if (!ctx.impersonating) {
    try {
      await (service as any).from("client_communications").insert({
        client_link_id: ctx.clientLinkId,
        sender_user_id: ctx.userId,
        direction: "from_client",
        kind: "message",
        body: [
          `🚫 Dismissed a bill from their "What you owe" view — says it isn't actually owed:`,
          `Bill ${docNumber ? `#${docNumber}` : billId}${vendorName ? ` — ${vendorName}` : ""}`,
          amount != null ? `Amount: $${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
          reason ? `Reason: ${reason}` : null,
          ``,
          `Still open in QuickBooks — needs a void or bill credit to clear for real.`,
        ]
          .filter((l) => l !== null)
          .join("\n"),
        attachments: [],
      });
    } catch (e) {
      console.warn("[ap-dismissals] comm mirror failed:", e);
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
  const billId = String(body.qbo_bill_id || "").trim();
  if (!billId) {
    return NextResponse.json({ error: "qbo_bill_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { error } = await (service as any)
    .from("portal_ap_dismissals")
    .delete()
    .eq("client_link_id", ctx.clientLinkId)
    .eq("qbo_bill_id", billId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
