import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/statements-stage
 * Body: { stage: "verified" | "draft" }
 *
 * Senior one-click DRAFT → VERIFIED graduation (Mike, 2026-07-15: client
 * approval raises the item; a human confirms — never automatic). "draft"
 * is allowed too so a senior can send a client back for another gut-check
 * cycle if something big changes (new accounts added, books restated).
 * Admin/lead only.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role)) {
    return NextResponse.json({ error: "Admin/lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const stage = String(body.stage || "");
  if (!["draft", "verified"].includes(stage)) {
    return NextResponse.json({ error: "stage must be 'draft' or 'verified'" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await service
    .from("client_links")
    .update(
      stage === "verified"
        ? ({ statements_stage: "verified", statements_verified_at: now, statements_verified_by: user.id } as any)
        : ({ statements_stage: "draft", statements_verified_at: null, statements_verified_by: null } as any)
    )
    .eq("id", clientLinkId)
    .select("id, client_name, statements_stage")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  await service.from("audit_log").insert({
    event_type: "statements_stage_changed",
    user_id: user.id,
    request_payload: {
      client_link_id: clientLinkId,
      client_name: (updated as any).client_name,
      stage,
    } as any,
  } as any);

  return NextResponse.json({ ok: true, stage: (updated as any).statements_stage });
}
