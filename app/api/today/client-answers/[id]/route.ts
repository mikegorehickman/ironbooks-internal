import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  reclassifyTransactionLines,
  buildAuditMemo,
  getValidToken,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts } from "@/lib/qbo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/today/client-answers/[id] — confirm or reject a client's answer
 * to an ask-client transaction question.
 *
 *   { action: "approve" }                                  → apply the client's pick
 *   { action: "approve_as", account_id?, account_name }    → apply an alternative
 *   { action: "reject", note? }                            → back to needs_review
 *
 * Approve writes to QBO immediately (same single-row path as re-execute):
 * one transaction, one line update, audit memo appended. Failures mark the
 * row failed with the QBO error and stay in the queue.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name, email")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { action?: string; account_id?: string; account_name?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { data: row } = await (service as any)
    .from("reclassifications")
    .select("*, reclass_jobs!reclass_job_id(id, reason, transactions_moved, client_links(*))")
    .eq("id", id)
    .single();
  if (!row) return NextResponse.json({ error: "Row not found" }, { status: 404 });
  if (row.decision !== "ask_client" || !row.client_responded_at) {
    return NextResponse.json({ error: "Not an answered client question" }, { status: 409 });
  }
  if (row.status === "executed") {
    return NextResponse.json({ ok: true, already_applied: true });
  }
  const job = row.reclass_jobs;
  const clientLink = job?.client_links;
  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const actorName = (actor as any).full_name || (actor as any).email || "Ironbooks";

  if (body.action === "reject") {
    const note = (body.note || "").trim().slice(0, 500);
    await (service as any)
      .from("reclassifications")
      .update({
        decision: "needs_review",
        error_message: `Client answer rejected by ${actorName}${note ? `: ${note}` : ""}`,
      })
      .eq("id", id);
    try {
      await (service as any).from("audit_log").insert({
        event_type: "client_answer_rejected",
        user_id: user.id,
        request_payload: {
          reclassification_id: id,
          client_link_id: clientLink.id,
          client_answer: row.client_response_account,
          note,
        },
      });
    } catch {}
    return NextResponse.json({ ok: true });
  }

  if (body.action !== "approve" && body.action !== "approve_as") {
    return NextResponse.json({ error: "action must be approve, approve_as, or reject" }, { status: 400 });
  }

  const isOverride = body.action === "approve_as";
  const targetNameRaw = isOverride ? (body.account_name || "").trim() : (row.client_response_account || "").trim();
  if (!targetNameRaw) {
    return NextResponse.json(
      { error: isOverride ? "account_name is required" : "The client left a note without picking an account — choose one from the dropdown." },
      { status: 400 }
    );
  }

  // Resolve the target against the client's LIVE chart of accounts.
  const accessToken = await getValidToken(clientLink.id, service as any);
  const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  let targetId = isOverride ? body.account_id || null : null;
  let targetName = targetNameRaw;
  if (!targetId) {
    const hit = accounts.find((a: any) => a.Active !== false && a.Name.toLowerCase() === targetNameRaw.toLowerCase());
    if (!hit) {
      return NextResponse.json(
        { error: `"${targetNameRaw}" isn't in their chart of accounts — pick an alternative.` },
        { status: 400 }
      );
    }
    targetId = hit.Id;
    targetName = hit.Name;
  }

  try {
    await reclassifyTransactionLines(clientLink.qbo_realm_id, accessToken, {
      txType: row.qbo_transaction_type as SupportedTxType,
      txId: row.qbo_transaction_id,
      lineUpdates: [{ line_id: row.line_id || "", new_account_id: targetId!, new_account_name: targetName }],
      auditMemo: buildAuditMemo(actorName, "Client answer confirmed"),
    });
  } catch (err: any) {
    await (service as any)
      .from("reclassifications")
      .update({ status: "failed", error_message: err.message })
      .eq("id", id);
    return NextResponse.json({ error: `QuickBooks rejected the update: ${err.message}` }, { status: 502 });
  }

  await (service as any)
    .from("reclassifications")
    .update({
      decision: "approved",
      status: "executed",
      executed_at: new Date().toISOString(),
      error_message: null,
      to_account_id: targetId,
      to_account_name: targetName,
      ...(isOverride
        ? { bookkeeper_override: true, bookkeeper_override_target_id: targetId, bookkeeper_override_target_name: targetName }
        : {}),
    })
    .eq("id", id);
  await (service as any)
    .from("reclass_jobs")
    .update({ transactions_moved: (job.transactions_moved || 0) + 1 })
    .eq("id", job.id);
  try {
    await (service as any).from("audit_log").insert({
      event_type: "client_answer_applied",
      user_id: user.id,
      request_payload: {
        reclassification_id: id,
        client_link_id: clientLink.id,
        client_answer: row.client_response_account,
        applied_account: targetName,
        source: isOverride ? "bookkeeper_alternative" : "client_pick",
      },
    });
  } catch {}

  return NextResponse.json({ ok: true, applied: targetName });
}
