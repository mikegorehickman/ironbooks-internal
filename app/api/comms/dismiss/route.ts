import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/comms/dismiss — mark inbound client messages handled (or undo).
 *
 * Dismissal is the "no reply needed" escape hatch. Replying already
 * auto-dismisses (see /api/clients/[id]/messages POST); this covers the case
 * where the answer went out over the phone, the client answered their own
 * question, or the message was an FYI.
 *
 * Body — one of:
 *   { ids: string[] }            dismiss specific messages
 *   { clientLinkId: string }     dismiss every open inbound row for a client
 * Plus optional:
 *   { undo: true }               clear dismissed_at instead of setting it
 *
 * Viewers are read-only and can't dismiss. Returns { ok, count }.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: { ids?: string[]; clientLinkId?: string; undo?: boolean };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = Array.isArray(payload.ids) ? payload.ids.filter(Boolean).slice(0, 500) : [];
  const clientLinkId = (payload.clientLinkId || "").trim();
  if (ids.length === 0 && !clientLinkId) {
    return NextResponse.json({ error: "ids or clientLinkId required" }, { status: 400 });
  }

  const undo = payload.undo === true;
  const patch = undo
    ? { dismissed_at: null, dismissed_by: null }
    : { dismissed_at: new Date().toISOString(), dismissed_by: user.id };

  let q = (service as any)
    .from("client_communications")
    .update(patch)
    .eq("direction", "from_client");
  if (ids.length > 0) q = q.in("id", ids);
  else q = q.eq("client_link_id", clientLinkId);
  // Only touch rows actually in the state we're leaving, so the returned
  // count reflects real work and a double-click is a no-op.
  q = undo ? q.not("dismissed_at", "is", null) : q.is("dismissed_at", null);

  const { data, error } = await q.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Home + the client list are server-rendered; bust their Router Cache
  // entries so the count is right when the user navigates back.
  revalidatePath("/today");
  revalidatePath("/home");
  revalidatePath("/inbox");
  revalidatePath("/clients");

  return NextResponse.json({ ok: true, count: ((data as any[]) || []).length });
}
