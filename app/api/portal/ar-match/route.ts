import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { applyClientMatch } from "@/lib/ar-match";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Portal side of invoice-match sessions.
 *
 * GET  → the open session + items for the signed-in client.
 * POST { item_id, answer, deposit_txn_id?, note? } → record one answer.
 *
 * Answers:
 *   paid_matched  (+ deposit_txn_id) — the ONLY answer that can write to QBO,
 *     and only when the session was sent with auto_apply AND the picked
 *     candidate is exact_eligible. The write path is applyDepositToInvoice
 *     with all its guards (closed period, stale check, snapshot, memo).
 *     Anything that fails a guard degrades to a proposal — never an error
 *     shown to the client.
 *   paid_no_match — proposal for the bookkeeper (with the client's hint).
 *   not_owed      — proposal; voids are always human-gated.
 *   still_owed    — resolved as real A/R (the chase list).
 */
export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ error: "No portal context" }, { status: 403 });
  const ctx = ctxResult.ctx;
  const service = createServiceSupabase();

  const { data: session } = await (service as any)
    .from("ar_match_sessions")
    .select("id, status, created_at")
    .eq("client_link_id", ctx.clientLinkId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!session) return NextResponse.json({ session: null, items: [] });

  const { data: items } = await (service as any)
    .from("ar_match_items")
    .select("id, qbo_invoice_id, doc_number, customer_name, txn_date, amount, balance, candidates, answer, answered_at, outcome")
    .eq("session_id", session.id)
    .order("txn_date", { ascending: true });
  return NextResponse.json({ session, items: items || [] });
}

export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ error: "No portal context" }, { status: 403 });
  const ctx = ctxResult.ctx;
  const service = createServiceSupabase();

  const body = await request.json().catch(() => ({} as any));
  const itemId = String(body.item_id || "");
  const answer = String(body.answer || "");
  const depositTxnId = body.deposit_txn_id ? String(body.deposit_txn_id) : null;
  const note = (body.note || "").toString().slice(0, 1000) || null;

  if (!itemId || !["paid_matched", "paid_no_match", "not_owed", "still_owed"].includes(answer)) {
    return NextResponse.json({ error: "item_id and a valid answer are required" }, { status: 400 });
  }
  if (answer === "paid_matched" && !depositTxnId) {
    return NextResponse.json({ error: "Pick which payment matches this invoice" }, { status: 400 });
  }

  // Item must belong to THIS client's open session and be unanswered.
  const { data: item } = await (service as any)
    .from("ar_match_items")
    .select("*, ar_match_sessions!inner(id, status, auto_apply)")
    .eq("id", itemId)
    .eq("client_link_id", ctx.clientLinkId)
    .single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const session = (item as any).ar_match_sessions;
  if (session.status !== "open") {
    return NextResponse.json({ error: "This review is no longer open" }, { status: 409 });
  }
  if (item.answered_at) {
    return NextResponse.json({ error: "Already answered" }, { status: 409 });
  }

  const nowIso = new Date().toISOString();
  let outcome = "proposed";
  let outcomeDetail: string | null = null;
  let appliedAt: string | null = null;

  if (answer === "still_owed") {
    // Real A/R — resolved; it feeds the follow-up list, not the fix queue.
    outcome = "kept";
    outcomeDetail = "client confirmed still owed";
  } else if (answer === "paid_matched" && depositTxnId) {
    const candidates = Array.isArray(item.candidates) ? item.candidates : [];
    const picked = candidates.find((c: any) => String(c.txn_id) === depositTxnId);
    if (!picked) {
      return NextResponse.json({ error: "That payment isn't one of the options" }, { status: 400 });
    }
    if (session.auto_apply && picked.exact_eligible) {
      // The one auto-apply case: exact candidate, session flagged, guards on.
      try {
        const { data: client } = await (service as any)
          .from("client_links")
          .select("id, client_name, qbo_realm_id, fiscal_year_end")
          .eq("id", ctx.clientLinkId)
          .single();
        const result = await applyClientMatch(service, client, item, depositTxnId, {
          dryRun: false,
          actorUserId: ctx.userId,
        });
        if (result.ok || result.outcome === "already_paid") {
          outcome = "auto_applied";
          outcomeDetail = result.outcome;
          appliedAt = nowIso;
        } else {
          outcomeDetail = `auto-apply declined (${result.outcome}${result.detail ? `: ${result.detail}` : ""}) — for the bookkeeper`;
        }
        await service.from("audit_log").insert({
          event_type: "ar_match_applied",
          user_id: ctx.userId,
          request_payload: {
            client_link_id: ctx.clientLinkId, item_id: itemId, deposit_txn_id: depositTxnId,
            by: "client_auto", session_id: session.id, ...result,
          } as any,
        });
      } catch (e: any) {
        outcomeDetail = `auto-apply errored (${String(e?.message || e).slice(0, 160)}) — for the bookkeeper`;
      }
    }
  }

  const { error: uErr } = await (service as any)
    .from("ar_match_items")
    .update({
      answer,
      matched_deposit_id: depositTxnId,
      client_note: note,
      answered_at: nowIso,
      outcome,
      outcome_detail: outcomeDetail,
      applied_at: appliedAt,
    })
    .eq("id", itemId);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  // Session complete? Mirror a summary into client_communications so the
  // bookkeeper's Today inbox picks it up with zero extra wiring.
  const { count: remaining } = await (service as any)
    .from("ar_match_items")
    .select("id", { count: "exact", head: true })
    .eq("session_id", session.id)
    .is("answered_at", null);
  if ((remaining || 0) === 0) {
    await (service as any)
      .from("ar_match_sessions")
      .update({ status: "completed", completed_at: nowIso })
      .eq("id", session.id);
    const { data: all } = await (service as any)
      .from("ar_match_items")
      .select("answer, outcome")
      .eq("session_id", session.id);
    const rows = (all as any[]) || [];
    const n = (k: string, field: "answer" | "outcome" = "answer") => rows.filter((r) => r[field] === k).length;
    await (service as any).from("client_communications").insert({
      client_link_id: ctx.clientLinkId,
      sender_user_id: ctx.userId,
      direction: "from_client",
      kind: "notification",
      subject: "Invoice check completed",
      body:
        `Finished the invoice review (${rows.length} invoices): ` +
        `${n("paid_matched")} matched to payments (${n("auto_applied", "outcome")} auto-applied), ` +
        `${n("paid_no_match")} paid but unmatched, ${n("not_owed")} not actually owed, ` +
        `${n("still_owed")} still outstanding. ` +
        `${n("proposed", "outcome")} need bookkeeper action — Admin → Revenue & A/R integrity.`,
    });
  }

  return NextResponse.json({ ok: true, outcome, applied: outcome === "auto_applied" });
}
