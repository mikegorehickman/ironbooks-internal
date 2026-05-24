import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { findUndepositedFundsAccountId } from "@/lib/qbo-balance-sheet";
import { scanUfAudit } from "@/lib/uf-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/clients/[id]/uf-audit/scan
 *
 * Pulls every UF Receive-Payment, classifies via LinkedTxn, persists results.
 * Returns the new scan_id so the UI can route to /uf-audit/[scanId].
 *
 * Owner bookkeeper or admin/lead only.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Auto-fail zombie "scanning" runs >5 min old, and cancel any prior
  // "review" runs (re-scanning means abandoning prior decisions).
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await service
    .from("uf_audit_scans" as any)
    .update({
      status: "failed",
      error_message: "Scan did not complete (server timeout). Re-scan to retry.",
    } as any)
    .eq("client_link_id", clientLinkId)
    .eq("status", "scanning")
    .lt("created_at", fiveMinAgo);
  await service
    .from("uf_audit_scans" as any)
    .update({ status: "cancelled" } as any)
    .eq("client_link_id", clientLinkId)
    .eq("status", "review");

  const c = client as any;

  const { data: runIns, error: runErr } = await service
    .from("uf_audit_scans" as any)
    .insert({
      client_link_id: clientLinkId,
      created_by: user.id,
      status: "scanning",
    } as any)
    .select()
    .single();
  if (runErr || !runIns) {
    return NextResponse.json(
      { error: `Failed to create scan row: ${runErr?.message || "unknown"}` },
      { status: 500 }
    );
  }
  const scanId = (runIns as any).id as string;
  const t0 = Date.now();

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const ufAccountId = await findUndepositedFundsAccountId(c.qbo_realm_id, accessToken);
    if (!ufAccountId) {
      throw new Error("No Undeposited Funds account found in QBO");
    }

    const result = await scanUfAudit(c.qbo_realm_id, accessToken, ufAccountId);

    // Insert items
    if (result.payments.length > 0) {
      const itemRows = result.payments.map((p) => ({
        scan_id: scanId,
        client_link_id: clientLinkId,
        qbo_payment_id: p.qbo_payment_id,
        qbo_payment_txn_type: p.qbo_payment_txn_type,
        payment_date: p.payment_date,
        payment_amount: p.payment_amount,
        customer_name: p.customer_name,
        customer_qbo_id: p.customer_qbo_id,
        applied_invoice_ids: p.applied_invoice_ids,
        payment_memo: p.payment_memo,
        classification: p.classification,
        matched_deposit_id: p.matched_deposit_id,
        matched_deposit_date: p.matched_deposit_date,
        matched_deposit_amount: p.matched_deposit_amount,
        matched_deposit_bank_account: p.matched_deposit_bank_account,
        match_confidence: p.classification === "matched" ? 1.0 : null,
        resolution: p.classification === "matched" ? "skipped" : "pending",
      }));
      const BATCH = 200;
      for (let i = 0; i < itemRows.length; i += BATCH) {
        const { error: itemErr } = await service
          .from("uf_audit_items" as any)
          .insert(itemRows.slice(i, i + BATCH) as any);
        if (itemErr) throw new Error(`Item insert failed: ${itemErr.message}`);
      }
    }

    await service
      .from("uf_audit_scans" as any)
      .update({
        status: "review",
        uf_account_qbo_id: ufAccountId,
        scan_from: result.scan_from,
        scan_to: result.scan_to,
        uf_payments_total: result.payments_total,
        matched_count: result.matched_count,
        orphan_count: result.orphan_count,
        total_uf_balance: result.total_uf_balance,
        total_orphan_amount: result.total_orphan_amount,
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", scanId);

    return NextResponse.json({
      ok: true,
      scan_id: scanId,
      payments_total: result.payments_total,
      orphan_count: result.orphan_count,
      total_orphan_amount: result.total_orphan_amount,
    });
  } catch (err: any) {
    await service
      .from("uf_audit_scans" as any)
      .update({
        status: "failed",
        error_message: err?.message || String(err),
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", scanId);
    return NextResponse.json(
      { error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
