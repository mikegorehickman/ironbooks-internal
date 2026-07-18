import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
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
    .select("id, qbo_realm_id, assigned_bookkeeper_id, jurisdiction")
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

    const region = String(c.jurisdiction || "US").toUpperCase().startsWith("CA") ? "CA" : "US";
    const result = await scanUfAudit(c.qbo_realm_id, accessToken, ufAccountId, { region });

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
        payment_ref_num: p.payment_ref_num,
        suspected_duplicate: p.suspected_duplicate,
        duplicate_of_payment_id: p.duplicate_of_payment_id,
        duplicate_reason: p.duplicate_reason,
        // Smart deposit match (migration 132). Guarded below so the insert still
        // works before that migration is applied.
        probable_deposit_id: p.probable_deposit_id,
        probable_deposit_date: p.probable_deposit_date,
        probable_deposit_amount: p.probable_deposit_amount,
        probable_deposit_bank: p.probable_deposit_bank,
        probable_match_kind: p.probable_match_kind,
        probable_match_confidence: p.probable_match_confidence,
        probable_match_note: p.probable_match_note,
        probable_match_group: p.probable_match_group,
        // Auto-recommend void_duplicate for suspected duplicates; everything
        // else orphan → pending; matched → skipped (no action).
        resolution:
          p.classification === "matched"
            ? "skipped"
            : p.suspected_duplicate
            ? "void_duplicate"
            : "pending",
        resolution_notes: p.suspected_duplicate ? p.duplicate_reason : null,
      }));
      // Strip the probable_* keys — the fallback shape for a pre-migration-132 DB.
      const PROBABLE_KEYS = [
        "probable_deposit_id", "probable_deposit_date", "probable_deposit_amount",
        "probable_deposit_bank", "probable_match_kind", "probable_match_confidence",
        "probable_match_note", "probable_match_group",
      ];
      const stripProbable = (r: any) => {
        const c = { ...r };
        for (const k of PROBABLE_KEYS) delete c[k];
        return c;
      };
      const BATCH = 200;
      for (let i = 0; i < itemRows.length; i += BATCH) {
        const slice = itemRows.slice(i, i + BATCH);
        let { error: itemErr } = await service.from("uf_audit_items" as any).insert(slice as any);
        // Migration 132 not applied yet → retry without the probable_* columns.
        if (itemErr && /probable_/.test(itemErr.message)) {
          ({ error: itemErr } = await service.from("uf_audit_items" as any).insert(slice.map(stripProbable) as any));
        }
        if (itemErr) throw new Error(`Item insert failed: ${itemErr.message}`);
      }
    }

    const scanUpdate: any = {
      status: "review",
      uf_account_qbo_id: ufAccountId,
      uf_account_name: result.uf_account_name,
      uf_account_current_balance: result.uf_account_current_balance,
      scan_from: result.scan_from,
      scan_to: result.scan_to,
      uf_payments_total: result.payments_total,
      matched_count: result.matched_count,
      orphan_count: result.orphan_count,
      total_uf_balance: result.total_uf_balance,
      total_orphan_amount: result.total_orphan_amount,
      probable_deposited_count: result.probable_deposited_count,
      probable_deposited_amount: result.probable_deposited_amount,
      duration_ms: Date.now() - t0,
    };
    let { error: scanUpdErr } = await service.from("uf_audit_scans" as any).update(scanUpdate).eq("id", scanId);
    if (scanUpdErr && /probable_/.test(scanUpdErr.message)) {
      delete scanUpdate.probable_deposited_count;
      delete scanUpdate.probable_deposited_amount;
      ({ error: scanUpdErr } = await service.from("uf_audit_scans" as any).update(scanUpdate).eq("id", scanId));
    }

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
    return qboErrorResponse(err);
  }
}
