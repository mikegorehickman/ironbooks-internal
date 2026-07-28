import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/last-close
 *
 * The end date of this client's most recent SUCCESSFUL month-end close, so a
 * cleanup/reclass job can scope itself to "everything since we last closed"
 * rather than re-touching months that already went out to the client.
 *
 * monthly_rec_runs is the authoritative record of a delivered close (a
 * client_months row can be mid-flight; a completed rec run means statements
 * actually went out). Falls back to the cleanup range end for a client that
 * has never closed a month — everything after cleanup is, by definition,
 * un-closed.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let lastCloseEnd: string | null = null;
  let source: "monthly_rec_run" | "cleanup_range" | null = null;

  try {
    const { data: run } = await (service as any)
      .from("monthly_rec_runs")
      .select("period_end, period, completed_at")
      .eq("client_link_id", id)
      .eq("status", "complete")
      .order("period", { ascending: false })
      .limit(1)
      .maybeSingle();
    if ((run as any)?.period_end) {
      lastCloseEnd = String((run as any).period_end).slice(0, 10);
      source = "monthly_rec_run";
    }
  } catch { /* fall through */ }

  if (!lastCloseEnd) {
    try {
      const { data: cl } = await (service as any)
        .from("client_links")
        .select("cleanup_range_end, cleanup_completed_at")
        .eq("id", id)
        .maybeSingle();
      if ((cl as any)?.cleanup_range_end) {
        lastCloseEnd = String((cl as any).cleanup_range_end).slice(0, 10);
        source = "cleanup_range";
      }
    } catch { /* fall through */ }
  }

  return NextResponse.json({ last_close_end: lastCloseEnd, source });
}
