import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { buildRevertPlan, executeRevertPlan, createdNamesFor } from "@/lib/coa-fleet-revert";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Fleet apply-master-coa revert — admin only.
 *
 * GET                      → clients that got accounts from the fleet runs
 *                            (from audit_log), with created counts.
 * POST { client_link_id, action: "plan" }
 *                          → READ-ONLY classification: safe / activity /
 *                            ambiguous / gone.
 * POST { client_link_id, action: "execute", dry_run? (default TRUE) }
 *                          → inactivate the SAFE accounts (children first).
 *                            dry_run must be explicitly false to write.
 *
 * Per-client only, by design — no fleet-wide execute (Clean Cut incident).
 */

async function requireAdmin() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 }) };
  }
  return { user, service };
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { service } = auth;

  const { data: ev } = await service
    .from("audit_log")
    .select("occurred_at, request_payload")
    .eq("event_type", "apply_master_coa")
    .order("occurred_at", { ascending: false })
    .limit(500);

  const byClient = new Map<string, { name: string; created: Set<string>; last_at: string }>();
  for (const e of (ev as any[]) || []) {
    const p = e.request_payload || {};
    if (!p.client_link_id) continue;
    const row = byClient.get(p.client_link_id) || {
      name: p.client_name || "(unknown)", created: new Set<string>(), last_at: e.occurred_at,
    };
    for (const n of p.created || []) row.created.add(typeof n === "string" ? n : n?.name || String(n));
    byClient.set(p.client_link_id, row);
  }

  // Only active clients with a live QBO connection are actionable.
  const ids = [...byClient.keys()];
  const { data: cls } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .in("id", ids);
  const linkOf = new Map(((cls as any[]) || []).map((c) => [c.id, c]));

  const clients = ids
    .map((id) => {
      const meta = byClient.get(id)!;
      const link = linkOf.get(id);
      return {
        client_link_id: id,
        client_name: link?.client_name || meta.name,
        created_count: meta.created.size,
        is_active: !!link?.is_active,
        has_qbo: !!link?.qbo_realm_id,
        last_applied_at: meta.last_at,
      };
    })
    .filter((c) => c.created_count > 0)
    .sort((a, b) => a.client_name.localeCompare(b.client_name));

  return NextResponse.json({ clients });
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { service, user } = auth;

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = String(body.client_link_id || "");
  const action = String(body.action || "plan");
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id) {
    return NextResponse.json({ error: "No QBO connection" }, { status: 400 });
  }

  if (action === "plan") {
    try {
      const plan = await buildRevertPlan(service, client as any);
      return NextResponse.json({ ok: true, plan });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 502 });
    }
  }

  if (action === "execute") {
    const dryRun = body.dry_run !== false; // writes are opt-in
    try {
      // Rebuild the plan at execute time — never act on a stale one.
      const plan = await buildRevertPlan(service, client as any);
      const result = await executeRevertPlan(service, client as any, plan, {
        dryRun,
        actorUserId: user.id,
      });
      if (!dryRun) {
        await service.from("audit_log").insert({
          event_type: "coa_fleet_revert_completed",
          user_id: user.id,
          request_payload: {
            client_link_id: clientLinkId,
            client_name: (client as any).client_name,
            inactivated: result.inactivated.length,
            failed: result.failed.length,
            left_with_activity: plan.activity.length,
            ambiguous: plan.ambiguous.length,
          } as any,
        });
      }
      return NextResponse.json({ ok: true, plan, result });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
