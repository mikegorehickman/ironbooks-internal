import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/coa-audit/history?client_link_id=X  (or ?name=Clean Cut)
 *
 * READ-ONLY recovery map: every COA-audit change ever applied to a client —
 * Fix-all re-types/creates/re-nests (coa_audit_fix), account merges
 * (coa_audit_merge), and cleanup-executor runs — newest first, from
 * audit_log. This is the forensic "what did the automated pass do" list that
 * a revert is built from. NO writes, no QBO calls.
 *
 * Incident 2026-07-18 (Clean Cut / Lisa): the Fix-all overrode a completed
 * manual cleanup (wages lumped to COGS, accounts inactivated with detail).
 * Use this to see exactly what to undo before any reversal.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const url = new URL(request.url);
  let clientLinkId = (url.searchParams.get("client_link_id") || "").trim();
  const name = (url.searchParams.get("name") || "").trim();

  if (!clientLinkId && name) {
    const { data: match } = await (service as any)
      .from("client_links")
      .select("id, client_name")
      .ilike("client_name", `%${name}%`)
      .limit(1)
      .maybeSingle();
    clientLinkId = match?.id || "";
  }
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id or name required" }, { status: 400 });

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, cleanup_completed_at")
    .eq("id", clientLinkId)
    .maybeSingle();

  // Every COA-audit / cleanup event for this client, newest first.
  const EVENTS = ["coa_audit_fix", "coa_audit_merge", "coa_reclass_je", "coa_cleanup_execute"];
  const { data: rows, error } = await (service as any)
    .from("audit_log")
    .select("event_type, request_payload, occurred_at, user_id")
    .filter("request_payload->>client_link_id", "eq", clientLinkId)
    .in("event_type", EVENTS)
    .order("occurred_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const events = ((rows as any[]) || []).map((r) => {
    const p = r.request_payload || {};
    const base = { event_type: r.event_type, at: r.occurred_at, by: r.user_id };
    if (r.event_type === "coa_audit_fix") {
      return {
        ...base,
        summary: `Fix-all: ${(p.retyped || []).length} re-typed, ${(p.created || []).length} created, ${(p.renested || []).length} re-nested${(p.failed || []).length ? `, ${p.failed.length} failed` : ""}`,
        retyped: p.retyped || [],
        created: p.created || [],
        renested: p.renested || [],
        failed: p.failed || [],
        conformance_after: p.conformance_after ?? null,
      };
    }
    if (r.event_type === "coa_audit_merge") {
      return {
        ...base,
        summary: `Merge: "${p.source}" → "${p.target}" (${p.lines_moved ?? 0} lines, $${Math.round(p.amount_swept || 0).toLocaleString()}, ${p.jes_posted ?? 0} JEs)${p.inactivated ? " · source inactivated" : ""}`,
        source: p.source,
        target: p.target,
        lines_moved: p.lines_moved,
        amount_swept: p.amount_swept,
        jes_posted: p.jes_posted,
        inactivated: p.inactivated,
        reactivated_deleted_source: p.reactivated_deleted_source,
        ytd: { start: p.ytd_start, end: p.ytd_end },
        failures: p.failures || [],
      };
    }
    return { ...base, summary: r.event_type, payload: p };
  });

  return NextResponse.json({
    client: client ? { id: client.id, name: client.client_name, cleanup_completed_at: client.cleanup_completed_at } : { id: clientLinkId },
    event_count: events.length,
    fix_runs: events.filter((e) => e.event_type === "coa_audit_fix").length,
    merges: events.filter((e) => e.event_type === "coa_audit_merge").length,
    events,
  });
}
