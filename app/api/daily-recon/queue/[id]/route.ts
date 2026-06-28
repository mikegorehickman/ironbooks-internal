import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, reclassifyTransactionLines } from "@/lib/qbo-reclass";
import { qboErrorResponse } from "@/lib/qbo";
import { upsertActivateRule } from "@/lib/bank-rules";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * PATCH /api/daily-recon/queue/[id]
 *
 * Bookkeeper action on a daily_review_queue row.
 *
 * Body:
 *   { action: "approve" }
 *      → push the suggested categorization to QBO, mark row 'executed'
 *   { action: "approve_with_override", target_account_id, target_account_name }
 *      → push the bookkeeper's override to QBO, mark row 'executed'
 *   { action: "reject", reason?: string }
 *      → just mark row 'rejected' (leaves QBO untouched — bookkeeper will
 *         categorize manually in QBO or come back to it)
 *   { action: "ask_client" }
 *      → mark row 'ask_client' so it shows up in the next client comms email
 *
 * Owner bookkeeper or admin/lead only.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: row } = await service
    .from("daily_review_queue" as any)
    .select("*, client_links!inner(id, qbo_realm_id, assigned_bookkeeper_id)")
    .eq("id", id)
    .single();
  if (!row) return NextResponse.json({ error: "Queue item not found" }, { status: 404 });
  const r = row as any;

  // Auth — owner bookkeeper, or admin/lead
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  const isSenior = ["admin", "lead"].includes(role);
  const isOwner = r.client_links.assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (r.decision !== "pending") {
    return NextResponse.json(
      { error: `Already decided as '${r.decision}'` },
      { status: 409 }
    );
  }

  const body = await request.json();
  const action = body.action as string;

  if (action === "reject") {
    await service
      .from("daily_review_queue" as any)
      .update({
        decision: "rejected",
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        ai_reasoning: body.reason ? `Rejected: ${body.reason}` : r.ai_reasoning,
      } as any)
      .eq("id", id);
    return NextResponse.json({ ok: true, decision: "rejected" });
  }

  if (action === "ask_client") {
    await service
      .from("daily_review_queue" as any)
      .update({
        decision: "ask_client",
        decided_by: user.id,
        decided_at: new Date().toISOString(),
      } as any)
      .eq("id", id);
    return NextResponse.json({ ok: true, decision: "ask_client" });
  }

  if (action === "approve" || action === "approve_with_override") {
    const targetId =
      action === "approve_with_override" ? body.target_account_id : r.suggested_account_id;
    const targetName =
      action === "approve_with_override" ? body.target_account_name : r.suggested_account_name;

    if (!targetId || !targetName) {
      return NextResponse.json({ error: "No target account assigned" }, { status: 400 });
    }

    try {
      const accessToken = await getValidToken(r.client_link_id, service as any);
      await reclassifyTransactionLines(r.client_links.qbo_realm_id, accessToken, {
        txType: r.qbo_transaction_type,
        txId: r.qbo_transaction_id,
        lineUpdates: [
          {
            line_id: r.qbo_line_id,
            new_account_id: targetId,
            new_account_name: targetName,
          },
        ],
        auditMemo: `Ironbooks daily recon — approved by bookkeeper`,
      });

      await service
        .from("daily_review_queue" as any)
        .update({
          decision: "executed",
          decided_by: user.id,
          decided_at: new Date().toISOString(),
          executed_at: new Date().toISOString(),
          suggested_account_id: targetId,
          suggested_account_name: targetName,
        } as any)
        .eq("id", id);

      // Learning loop: optionally teach a bank rule so this vendor
      // auto-categorizes next run. Best-effort — the QBO write already
      // succeeded, so a rule hiccup must not fail the decision.
      let bankRuleCreated = false;
      if (body.create_rule && r.vendor_name) {
        try {
          const res = await upsertActivateRule(service as any, {
            client_link_id: r.client_link_id,
            vendor: r.vendor_name,
            target_account_name: targetName,
            created_by: user.id,
            sample_descriptions: r.description ? [String(r.description)] : [],
            transaction_count: 1,
            total_amount: r.transaction_amount || 0,
          });
          bankRuleCreated = res.created;
        } catch {
          bankRuleCreated = false;
        }
      }

      return NextResponse.json({ ok: true, decision: "executed", bank_rule_created: bankRuleCreated });
    } catch (err: any) {
      return qboErrorResponse(err);
    }
  }

  return NextResponse.json({ error: `Unknown action '${action}'` }, { status: 400 });
}
