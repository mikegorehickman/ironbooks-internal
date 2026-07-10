import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/cleanup-system/auth";
import { MODULE_ORDER, ACTIVE_CLEANUP_STATUSES } from "@/lib/cleanup-system/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: run, error } = await service
    .from("cleanup_runs")
    .select("*")
    .eq("id", runId)
    .single();
  if (error || !run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  let { data: modules } = await service
    .from("cleanup_run_modules")
    .select("*")
    .eq("run_id", runId)
    .order("created_at");

  // Backfill-on-read: runs created before a module existed (e.g. ar_aging,
  // added mid-flight for open runs) get the missing rows seeded "ready".
  // UNIQUE(run_id, module) makes the insert race-safe; a failed insert (the
  // enum value's migration not applied yet) is silently tolerated — the
  // module simply doesn't appear until migration 114 lands.
  const have = new Set(((modules as any[]) || []).map((m) => m.module));
  const missing = MODULE_ORDER.filter((m) => !have.has(m));
  const runActive = ACTIVE_CLEANUP_STATUSES.includes((run as any).status);
  if (missing.length > 0 && runActive) {
    try {
      const { error: insErr } = await service.from("cleanup_run_modules").insert(
        missing.map((module) => ({ run_id: runId, module, status: "ready" })) as any
      );
      if (!insErr) {
        const refreshed = await service
          .from("cleanup_run_modules")
          .select("*")
          .eq("run_id", runId)
          .order("created_at");
        modules = refreshed.data;
      }
    } catch {
      /* pre-migration env — show existing modules only */
    }
  }

  const { data: healthScore } = await service
    .from("bs_health_scores")
    .select("*")
    .eq("run_id", runId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: proposedCount } = await service
    .from("proposed_entries")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);

  const { count: pendingReview } = await service
    .from("proposed_entries")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .in("decision", ["pending", "needs_review", "flagged"]);

  const { data: cpaFlags } = await service
    .from("cpa_flags")
    .select("id, flag_type, description, status")
    .eq("run_id", runId);

  return NextResponse.json({
    run,
    modules: modules || [],
    health_score: healthScore,
    counts: {
      proposed: proposedCount || 0,
      pending_review: pendingReview || 0,
    },
    cpa_flags: cpaFlags || [],
  });
}
