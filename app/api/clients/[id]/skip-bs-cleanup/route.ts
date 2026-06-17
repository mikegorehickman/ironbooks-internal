import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/skip-bs-cleanup  — admin/lead only.
 *
 * Body: { skip: boolean }
 *   skip=true  → mark this client as NOT needing a balance-sheet cleanup;
 *                they advance past the bs_cleanup stage (drops out of the BS
 *                kanban column, counts as BS-done in progress).
 *   skip=false → undo (they owe a BS cleanup again).
 *
 * Reversible + audited. Does NOT itself complete cleanup or promote to
 * production — it only removes the BS gate so the manager can move on.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Only an admin or lead can skip BS cleanup" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const skip = body.skip !== false; // default to skipping
  const now = new Date().toISOString();

  const { data: prior } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", id)
    .single();
  if (!prior) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { error } = await service
    .from("client_links")
    .update({
      bs_cleanup_skipped_at: skip ? now : null,
      bs_cleanup_skipped_by: skip ? user.id : null,
    } as any)
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: skip ? "bs_cleanup_skipped" : "bs_cleanup_skip_undone",
    request_payload: { client_link_id: id, client_name: (prior as any).client_name } as any,
  });

  return NextResponse.json({ ok: true, skipped: skip });
}
