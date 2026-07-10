import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { MODULE_ORDER, type CleanupModule } from "@/lib/cleanup-system/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/cleanup/[runId]/modules/[module]/skip   { unskip?: boolean }
 *
 * Mark a module as skipped (or put it back to ready). The `skipped` status
 * has existed in the enum since migration 53 and the QA gate has always
 * accepted it as complete-equivalent — but no code path ever SET it, so an
 * optional module a client didn't need still blocked delivery forever. This
 * closes that gap for every module, prompted by AR Aging Cleanup being the
 * first genuinely optional one.
 *
 * Guard: a module with executed entries can't be skipped — that would hide
 * work that already hit QBO.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; module: string }> }
) {
  const { runId, module } = await context.params;
  const body = await request.json().catch(() => ({}));
  const unskip = body?.unskip === true;

  if (!MODULE_ORDER.includes(module as CleanupModule) && module !== "obe_uncategorized") {
    return NextResponse.json({ error: "Invalid module" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("cleanup_runs")
    .select("client_link_id")
    .eq("id", runId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const perm = await requireOwnerOrSenior(
    service,
    (run as any).client_link_id,
    auth.userId,
    auth.role
  );
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  if (!unskip) {
    // `as any`: the generated DB types predate the ar_aging enum value
    // (migration 114) — same convention as every post-generation column.
    const { count: executedCount } = await (service as any)
      .from("proposed_entries")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("module", module)
      .eq("executed", true);
    if ((executedCount || 0) > 0) {
      return NextResponse.json(
        { error: `${executedCount} entries in this module already posted to QuickBooks — it can't be skipped.` },
        { status: 400 }
      );
    }
  }

  // skipped_at/by are migration-114 columns; write them best-effort so the
  // skip still works while the migration is pending.
  const base = unskip
    ? { status: "ready" }
    : { status: "skipped" };
  const full = unskip
    ? { ...base, skipped_at: null, skipped_by: null }
    : { ...base, skipped_at: new Date().toISOString(), skipped_by: auth.userId };

  let { error } = await (service as any)
    .from("cleanup_run_modules")
    .update(full as any)
    .eq("run_id", runId)
    .eq("module", module);
  if (error) {
    ({ error } = await (service as any)
      .from("cleanup_run_modules")
      .update(base as any)
      .eq("run_id", runId)
      .eq("module", module));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await service.from("audit_log").insert({
      event_type: unskip ? "cleanup_module_unskipped" : "cleanup_module_skipped",
      user_id: auth.userId,
      request_payload: { run_id: runId, module, client_link_id: (run as any).client_link_id },
    } as any);
  } catch {}

  return NextResponse.json({ ok: true, module, status: unskip ? "ready" : "skipped" });
}
