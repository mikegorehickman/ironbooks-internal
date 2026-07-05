import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * /api/escalations — the one client-escalation mechanism.
 *
 * GET  ?status=open|resolved|all (default open)
 *      → escalations enriched with client + user names, newest first.
 * POST { client_link_id, reason, kind?, note? }
 *      → raise. One OPEN escalation per (client, kind): a duplicate raise
 *        APPENDS the new context to the existing row's note (never silently
 *        dropped) and returns it (200, deduped: true) instead of stacking.
 *
 * Any staff member can raise; resolution lives in /api/escalations/[id].
 */
export async function GET(request: Request) {
  const auth = await requireStaff();
  if (auth.error) return auth.error;
  const service = auth.service;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "open";

  let query = (service as any)
    .from("client_escalations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status !== "all") query = query.eq("status", status);

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = await enrich(service, (rows as any[]) || []);
  return NextResponse.json({ ok: true, escalations: enriched });
}

export async function POST(request: Request) {
  const auth = await requireStaff();
  if (auth.error) return auth.error;
  const { service, userId } = auth;

  let body: {
    client_link_id?: string;
    reason?: string;
    kind?: string;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const clientLinkId = (body.client_link_id || "").trim();
  const reason = (body.reason || "").trim().slice(0, 300);
  if (!clientLinkId || !reason) {
    return NextResponse.json({ error: "client_link_id and reason are required" }, { status: 400 });
  }
  const kind = ["general", "billing", "statement", "client_relationship"].includes(body.kind || "")
    ? body.kind
    : "general";
  const note = (body.note || "").trim().slice(0, 2000) || null;

  // Dedup: fold into the existing open escalation instead of stacking. The
  // second raiser's context is APPENDED, never dropped — the senior sees
  // both takes on the one row the boards already render.
  const { data: existing } = await (service as any)
    .from("client_escalations")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .eq("kind", kind)
    .eq("status", "open")
    .maybeSingle();
  if (existing) {
    const addition = [reason !== existing.reason ? reason : null, note].filter(Boolean).join(" — ");
    let updated = existing;
    if (addition) {
      const { data: raiser } = await service
        .from("users")
        .select("full_name, email")
        .eq("id", userId)
        .single();
      const who = (raiser as any)?.full_name || (raiser as any)?.email || "someone";
      const merged = [existing.note, `${who}: ${addition}`].filter(Boolean).join("\n").slice(0, 4000);
      const { data: after } = await (service as any)
        .from("client_escalations")
        .update({ note: merged })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (after) updated = after;
    }
    const [row] = await enrich(service, [updated]);
    return NextResponse.json({ ok: true, deduped: true, escalation: row });
  }

  const { data: created, error } = await (service as any)
    .from("client_escalations")
    .insert({
      client_link_id: clientLinkId,
      kind,
      reason,
      note,
      raised_by: userId,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Observability trail, same pattern as other client-facing events.
  try {
    await (service as any).from("audit_log").insert({
      event_type: "client_escalation_raised",
      user_id: userId,
      request_payload: { client_link_id: clientLinkId, kind, reason },
    });
  } catch {
    /* best-effort */
  }

  const [row] = await enrich(service, [created]);
  return NextResponse.json({ ok: true, escalation: row });
}

/** Staff-gate shared by both methods (admin/lead/bookkeeper). */
async function requireStaff(): Promise<
  | { error: NextResponse; service?: never; userId?: never }
  | { error?: never; service: any; userId: string }
> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { service, userId: user.id };
}

/** Attach client + user display names. */
async function enrich(service: any, rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;
  const clientIds = [...new Set(rows.map((r) => r.client_link_id))];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.raised_by, r.assignee_id, r.resolved_by]).filter(Boolean)),
  ];
  const [{ data: clients }, { data: users }] = await Promise.all([
    service.from("client_links").select("id, client_name, legal_business_name").in("id", clientIds),
    userIds.length
      ? service.from("users").select("id, full_name, email").in("id", userIds)
      : Promise.resolve({ data: [] }),
  ]);
  const clientById = new Map(((clients as any[]) || []).map((c) => [c.id, c.legal_business_name || c.client_name]));
  const nameById = new Map(((users as any[]) || []).map((u) => [u.id, u.full_name || u.email]));
  return rows.map((r) => ({
    ...r,
    client_name: clientById.get(r.client_link_id) || "(unknown client)",
    raised_by_name: r.raised_by ? nameById.get(r.raised_by) || null : null,
    assignee_name: r.assignee_id ? nameById.get(r.assignee_id) || null : null,
    resolved_by_name: r.resolved_by ? nameById.get(r.resolved_by) || null : null,
  }));
}
