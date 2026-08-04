import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { parseRunPeriod } from "@/lib/statement-notices";
import { generateNoticeDraft } from "@/lib/statement-notices-server";

/**
 * POST /api/clients/[id]/notice-draft   { period: "YYYY-MM" }
 *
 * Drafts the AI section of a Notice to Reader for the rec-card compose panel:
 * "what we noticed / what we need from you", assembled from what SNAP already
 * knows about the month (approved red flags, the bookkeeper's internal concerns
 * — rephrased, never quoted — outstanding draft-send questions, unanswered
 * client messages). The manager edits the result; NOTHING here is auto-sent.
 *
 * Senior only (admin/lead) — the same people who can send. Generation is on
 * demand, so there's nothing to cache or clean up; the sent text is what gets
 * snapshotted, on the notice row and in audit_log.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  let year: number, month: number;
  try {
    ({ year, month } = parseRunPeriod(String(body.period || "")));
  } catch {
    return NextResponse.json({ error: "period must be YYYY-MM" }, { status: 400 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  try {
    const draft = await generateNoticeDraft(service, clientLinkId, year, month);
    return NextResponse.json({ ok: true, draft });
  } catch (e: any) {
    console.error(`[notice-draft] ${clientLinkId} ${body.period}: ${e?.message}`);
    return NextResponse.json(
      { error: e?.message || "Couldn't draft the notice — write it manually or try again." },
      { status: 500 }
    );
  }
}
