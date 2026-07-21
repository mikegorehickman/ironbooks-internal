import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { readPriorYearTracking, type PriorYearStatus } from "@/lib/prior-year-cleanup";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/clients/[id]/prior-year-cleanup — senior-only.
 * Update the prior-year catch-up tracking for a client.
 * Body: { status?, years?, note?, markNotified?: boolean }
 */
const STATUSES: PriorYearStatus[] = [
  "flagged", "quoted", "notified", "approved", "in_progress", "done", "not_needed",
];

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users").select("role, full_name").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Senior only" }, { status: 403 });
  }

  let body: { status?: string; years?: number[]; note?: string; markNotified?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.status && !STATUSES.includes(body.status as PriorYearStatus)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { data: row, error: readErr } = await service
    .from("client_links").select("prior_year_cleanup").eq("id", id).single();
  if (readErr) {
    return NextResponse.json(
      { error: "Couldn't save — run migration 139 (prior_year_cleanup).", reason: "not_migrated" },
      { status: 409 }
    );
  }
  if (!row) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const current = readPriorYearTracking(row as any);
  const nowIso = new Date().toISOString();
  const actorName = (actor as any)?.full_name || (actor as any)?.email || user.id;
  const next = {
    ...current,
    ...(body.status ? { status: body.status } : {}),
    ...(Array.isArray(body.years) ? { years: body.years } : {}),
    ...(typeof body.note === "string" ? { note: body.note.slice(0, 1000) } : {}),
    ...(body.markNotified ? { notified_at: nowIso, status: current.status === "flagged" || !current.status ? "notified" : current.status } : {}),
    updated_at: nowIso,
    updated_by: actorName,
  };

  const { error: updErr } = await (service as any)
    .from("client_links").update({ prior_year_cleanup: next }).eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "prior_year_cleanup_updated",
    request_payload: { client_link_id: id, ...next } as any,
  });

  return NextResponse.json({ ok: true, tracking: next });
}
