import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { applyClientMatch } from "@/lib/ar-match";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Staff resolution of client answers (the proposal queue).
 *
 * POST { item_id, action: "apply" | "keep" | "dismiss", deposit_txn_id? }
 *   apply   — write the match to QBO (admin/lead only). Uses the client's
 *             picked deposit unless deposit_txn_id overrides it.
 *   keep    — resolve with no QBO change (invoice is real / handled elsewhere).
 *   dismiss — drop the proposal (client was wrong / duplicate answer).
 *
 * Voids are deliberately NOT an action here: "not_owed" proposals get
 * resolved through the remediation panel where the void path already has its
 * guards (snapshot, closed-period, dry-run).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const itemId = String(body.item_id || "");
  const action = String(body.action || "");
  if (!itemId || !["apply", "keep", "dismiss"].includes(action)) {
    return NextResponse.json({ error: "item_id and a valid action are required" }, { status: 400 });
  }
  if (action === "apply" && !["admin", "lead"].includes(role)) {
    return NextResponse.json({ error: "Only admin/lead can apply to QBO." }, { status: 403 });
  }

  const { data: item } = await (service as any)
    .from("ar_match_items")
    .select("*")
    .eq("id", itemId)
    .eq("client_link_id", id)
    .single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (item.outcome && item.outcome !== "proposed") {
    return NextResponse.json({ error: `Already resolved (${item.outcome}).` }, { status: 409 });
  }

  if (action === "apply") {
    const depositTxnId = String(body.deposit_txn_id || item.matched_deposit_id || "");
    if (!depositTxnId) {
      return NextResponse.json({ error: "No deposit picked for this item." }, { status: 400 });
    }
    const { data: client } = await (service as any)
      .from("client_links")
      .select("id, client_name, qbo_realm_id, fiscal_year_end")
      .eq("id", id)
      .single();
    const result = await applyClientMatch(service, client, item, depositTxnId, {
      dryRun: false,
      actorUserId: user.id,
    });
    const resolved = result.ok || result.outcome === "already_paid";
    await (service as any)
      .from("ar_match_items")
      .update({
        outcome: resolved ? "applied_by_bookkeeper" : "proposed",
        outcome_detail: `${result.outcome}${result.detail ? `: ${result.detail}` : ""}`,
        applied_at: resolved ? new Date().toISOString() : null,
        resolved_by: resolved ? user.id : null,
        matched_deposit_id: depositTxnId,
      })
      .eq("id", itemId);
    await service.from("audit_log").insert({
      event_type: "ar_match_applied",
      user_id: user.id,
      request_payload: {
        client_link_id: id, item_id: itemId, deposit_txn_id: depositTxnId,
        by: "bookkeeper", ...result,
      } as any,
    });
    if (!resolved) {
      return NextResponse.json({ error: `Apply failed — ${result.outcome}${result.detail ? `: ${result.detail}` : ""}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, result });
  }

  await (service as any)
    .from("ar_match_items")
    .update({
      outcome: action === "keep" ? "kept" : "dismissed",
      outcome_detail: (body.note || "").toString().slice(0, 300) || null,
      resolved_by: user.id,
    })
    .eq("id", itemId);
  return NextResponse.json({ ok: true });
}
