import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { buildConformancePlan, executeConformancePlan } from "@/lib/coa-conformance";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Fleet COA conformance — admin only.
 *
 * GET  → every active QBO client with its last known conformance % (from the
 *        coa_audit_scans cache) so the board loads without hitting QBO.
 * POST { client_link_id, action: "plan" }
 *        → READ-ONLY: creates / retypes / merges / unmatched for that client.
 * POST { client_link_id, action: "execute", merge_source_ids?, skip_merges? }
 *        → create → retype → merge (NO JE). Plan is rebuilt server-side, so a
 *          stale preview can never drive a write.
 *
 * Per-client only — no fleet-wide execute (Clean Cut rule).
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

  const { data: cls } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, is_active, qbo_realm_id, cleanup_completed_at")
    .eq("is_active", true);
  const clients = ((cls as any[]) || []).filter(
    (c) => c.qbo_realm_id && c.qbo_realm_id !== "DEMO" && !/\btest\b/i.test(c.client_name || "")
  );

  let scans: any[] = [];
  try {
    const { data } = await (service as any)
      .from("coa_audit_scans")
      .select("client_link_id, conformance_pct, issue_count, non_master, scanned_at");
    scans = (data as any[]) || [];
  } catch { /* table optional */ }
  const scanBy = new Map(scans.map((s) => [s.client_link_id, s]));

  const rows = clients
    .map((c) => {
      const s = scanBy.get(c.id);
      return {
        client_link_id: c.id,
        client_name: c.client_name,
        jurisdiction: c.jurisdiction || "US",
        cleanup_completed: !!c.cleanup_completed_at,
        conformance_pct: s ? Number(s.conformance_pct) : null,
        non_master: s ? Number(s.non_master) : null,
        issue_count: s ? Number(s.issue_count) : null,
        scanned_at: s?.scanned_at || null,
      };
    })
    .sort((a, b) => (a.conformance_pct ?? 999) - (b.conformance_pct ?? 999));

  return NextResponse.json({ clients: rows });
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
    .select("id, client_name, qbo_realm_id, jurisdiction, industry, cleanup_completed_at")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id) {
    return NextResponse.json({ error: "No QBO connection" }, { status: 400 });
  }

  try {
    if (action === "plan") {
      const plan = await buildConformancePlan(service, client as any);
      return NextResponse.json({ ok: true, plan, cleanup_completed: !!(client as any).cleanup_completed_at });
    }
    if (action === "execute") {
      // A finished cleanup is a human's work product — never overwrite it
      // without an explicit in-app confirm (Clean Cut, 2026-07-18).
      if ((client as any).cleanup_completed_at && body.allow_completed !== true) {
        return NextResponse.json({
          error: "cleanup_complete",
          message: `${(client as any).client_name}'s cleanup is marked complete. Re-confirm to run conformance against it.`,
        }, { status: 409 });
      }
      const { plan, result } = await executeConformancePlan(service, client as any, {
        actorUserId: user.id,
        mergeSourceIds: Array.isArray(body.merge_source_ids) ? body.merge_source_ids : null,
        skipMerges: body.skip_merges === true,
      });
      return NextResponse.json({ ok: true, plan, result });
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 502 });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
