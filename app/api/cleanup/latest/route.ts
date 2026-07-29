import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { requireStaff } from "@/lib/cleanup-system/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/cleanup/latest?client=<client_link_id>
 *
 * The client's most recent BS-cleanup run + its health score, so the main
 * Balance Sheet page can show "what needs fixing" WHERE the fixing happens.
 * Before this, the checklist only lived on the wizard, whose Fix buttons
 * linked back to the Balance Sheet page — a two-page ping-pong for every
 * single item (Mike, 2026-07-29).
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const clientLinkId = (url.searchParams.get("client") || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client required" }, { status: 400 });

  const service = createServiceSupabase();
  const { data: run } = await (service as any)
    .from("cleanup_runs")
    .select("id, status, created_at")
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return NextResponse.json({ run: null, health_score: null });

  const { data: hs } = await (service as any)
    .from("bs_health_scores")
    .select("overall_score, task_list, computed_at")
    .eq("run_id", (run as any).id)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ run, health_score: hs || null });
}
