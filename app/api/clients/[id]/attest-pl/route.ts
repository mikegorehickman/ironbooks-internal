import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/attest-pl  { attested: true, notes?: string }
 *
 * Bookkeeper signs off that they've reviewed the P&L for the cleanup window and
 * it's accurate. This is the prerequisite for submitting the cleanup for senior
 * review (enforced server-side in submit-for-review with a 422). DELETE un-attests.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  if (!body?.attested) {
    return NextResponse.json({ error: "attested:true is required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { error } = await service
    .from("client_links")
    .update({
      pl_attested_at: new Date().toISOString(),
      pl_attested_by: user.id,
      pl_attestation_notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : null,
    } as any)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "cleanup_pl_attested",
      request_payload: { client_link_id: clientLinkId, notes: body.notes || null } as any,
    });
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ ok: true, attested_at: new Date().toISOString() });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { error } = await service
    .from("client_links")
    .update({ pl_attested_at: null, pl_attested_by: null, pl_attestation_notes: null } as any)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
