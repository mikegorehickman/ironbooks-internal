import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { buildQboInstructions, computeSessionMath } from "@/lib/recon-sessions";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STAFF = ["admin", "lead", "bookkeeper"];

async function gate(sessionId: string) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { fail: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!STAFF.includes((actor as any)?.role || "")) {
    return { fail: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const { data: session } = await (service as any)
    .from("recon_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (!session) return { fail: NextResponse.json({ error: "Session not found" }, { status: 404 }) };
  return { user, service, session };
}

async function loadTxns(service: any, sessionId: string) {
  const { data } = await service
    .from("recon_session_txns")
    .select("id, origin, qbo_txn_id, txn_type, txn_date, doc_num, payee, memo, amount, checked, match_source, matched_line_date, matched_line_desc")
    .eq("session_id", sessionId)
    .order("txn_date", { ascending: true });
  return (data || []) as any[];
}

function payload(session: any, txns: any[]) {
  const math = computeSessionMath(session, txns);
  const instructions = buildQboInstructions(session, txns);
  return { session, txns, math, instructions };
}

/** GET /api/recon/[sessionId] — session + worksheet rows + live math + QBO steps. */
export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const g = await gate(sessionId);
  if ("fail" in g) return g.fail;
  const txns = await loadTxns(g.service, sessionId);
  return NextResponse.json(payload(g.session, txns));
}

/**
 * PATCH /api/recon/[sessionId]
 *   { txn_ids: string[], checked: boolean }        → toggle worksheet rows
 *   { ending_balance?, beginning_balance? }        → edit the truth values
 */
export async function PATCH(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const g = await gate(sessionId);
  if ("fail" in g) return g.fail;
  const { service, session } = g;
  if (session.status === "finished") {
    return NextResponse.json({ error: "Session is finished — reopen it first." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));

  if (Array.isArray(body.txn_ids) && typeof body.checked === "boolean" && body.txn_ids.length > 0) {
    const { error } = await (service as any)
      .from("recon_session_txns")
      .update({ checked: body.checked, match_source: body.checked ? "manual" : null })
      .eq("session_id", sessionId)
      .in("id", body.txn_ids)
      .eq("origin", "qbo");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const patch: Record<string, any> = {};
  if (body.ending_balance != null && Number.isFinite(Number(body.ending_balance))) {
    patch.ending_balance = Number(body.ending_balance);
  }
  if (body.beginning_balance != null && Number.isFinite(Number(body.beginning_balance))) {
    patch.beginning_balance = Number(body.beginning_balance);
    patch.beginning_source = "manual";
  }

  const txns = await loadTxns(service, sessionId);
  const merged = { ...session, ...patch };
  const math = computeSessionMath(merged, txns);
  patch.difference = math.difference;
  patch.cleared_count = math.checkedCount;
  patch.updated_at = new Date().toISOString();
  const { error: sessErr } = await (service as any)
    .from("recon_sessions")
    .update(patch)
    .eq("id", sessionId);
  if (sessErr) return NextResponse.json({ error: sessErr.message }, { status: 500 });

  return NextResponse.json(payload(merged, txns));
}

/**
 * POST /api/recon/[sessionId]  { action: "finish" | "reopen" | "abandon" }
 * Finish requires difference = $0.00 (or force: true to override), snapshots
 * the QBO instructions, and stamps the linked statement reconciled.
 */
export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const g = await gate(sessionId);
  if ("fail" in g) return g.fail;
  const { user, service, session } = g;
  const body = await request.json().catch(() => ({}));
  const action = body.action;

  if (action === "reopen") {
    await (service as any)
      .from("recon_sessions")
      .update({ status: "in_progress", finished_at: null, finished_by: null, updated_at: new Date().toISOString() })
      .eq("id", sessionId);
    const txns = await loadTxns(service, sessionId);
    return NextResponse.json(payload({ ...session, status: "in_progress" }, txns));
  }

  if (action === "abandon") {
    await (service as any)
      .from("recon_sessions")
      .update({ status: "abandoned", updated_at: new Date().toISOString() })
      .eq("id", sessionId);
    return NextResponse.json({ ok: true });
  }

  if (action !== "finish") {
    return NextResponse.json({ error: "action must be finish, reopen, or abandon" }, { status: 400 });
  }

  const txns = await loadTxns(service, sessionId);
  const math = computeSessionMath(session, txns);
  if (Math.abs(math.difference) > 0.005 && body.force !== true) {
    return NextResponse.json(
      { error: `Difference is ${math.difference.toFixed(2)} — not balanced. Fix it, or finish with force to record as-is.`, difference: math.difference },
      { status: 409 }
    );
  }

  const instructions = buildQboInstructions(session, txns);
  const now = new Date().toISOString();
  const { error } = await (service as any)
    .from("recon_sessions")
    .update({
      status: "finished",
      difference: math.difference,
      cleared_count: math.checkedCount,
      qbo_instructions: instructions,
      finished_by: user.id,
      finished_at: now,
      updated_at: now,
    })
    .eq("id", sessionId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (session.statement_id) {
    await (service as any)
      .from("client_statements")
      .update({ reconciled_session_id: sessionId, reconciled_at: now })
      .eq("id", session.statement_id)
      .then(() => {}, () => {});
  }

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "recon_session_finished",
      request_payload: {
        client_link_id: session.client_link_id,
        account: session.qbo_account_name,
        statement_end_date: session.statement_end_date,
        ending_balance: session.ending_balance,
        difference: math.difference,
        cleared: math.checkedCount,
        forced: body.force === true,
      } as any,
    });
  } catch {
    /* non-fatal */
  }

  return NextResponse.json(payload({ ...session, status: "finished", qbo_instructions: instructions }, txns));
}
