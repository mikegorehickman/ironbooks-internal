import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/admin/upgrade-action
 *
 * Records a reviewer's decision on an upgrade candidate so resolved rows stop
 * nagging on /admin/upgrades. Admin / lead / billing_admin only.
 *
 * Body: { client_link_id, decision, note?, snooze_until?, target_tier? }
 *   decision ∈ pending | upgrade_sent | upgraded | dismissed | snoozed
 *
 * Requires migration 105 (client_upgrade_actions). Returns a clear message if
 * the table isn't there yet.
 */

const DECISIONS = ["pending", "upgrade_sent", "upgraded", "dismissed", "snoozed"];

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { client_link_id, decision, note, snooze_until, target_tier } = body;
  if (!client_link_id || !DECISIONS.includes(decision)) {
    return NextResponse.json({ error: "client_link_id and a valid decision are required" }, { status: 400 });
  }

  const { error } = await (service as any)
    .from("client_upgrade_actions")
    .upsert(
      {
        client_link_id,
        decision,
        note: note ?? null,
        snooze_until: decision === "snoozed" ? snooze_until ?? null : null,
        target_tier: target_tier ?? null,
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "client_link_id" }
    );

  if (error) {
    const missing = /relation .*client_upgrade_actions.* does not exist/i.test(error.message);
    return NextResponse.json(
      { error: missing ? "Run migration 105 first to enable the mark-handled workflow." : error.message },
      { status: missing ? 409 : 500 }
    );
  }

  // Best-effort audit trail.
  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "upgrade_action",
      request_payload: { client_link_id, decision, note: note ?? null } as any,
    });
  } catch { /* audit is best-effort */ }

  return NextResponse.json({ ok: true });
}
