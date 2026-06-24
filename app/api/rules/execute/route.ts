import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/rules/execute
 *
 * Body: { discovery_job_id: string }
 *
 * Activates all approved bank rules for this discovery job.
 *
 * ═══ Why we don't push to QBO anymore ═══
 *
 * QBO's public API does NOT support creating bank rules. The /bankrule
 * endpoint is listed in Intuit's docs but returns
 *   {"Fault":{"Error":[{"Message":"Unsupported Operation",
 *    "Detail":"Operation bankrule is not supported.","code":"500"}]}}
 * for every POST. This is a known long-standing Intuit limitation —
 * bank rules can only be created through the QBO UI by the user.
 *
 * Instead, our rules are ACTIVE inside SNAP's daily-recon engine
 * (lib/daily-recon.ts). When new transactions sync from QBO, the
 * engine matches them against bank_rules and posts the reclass
 * directly to QBO — which IS supported via the Reclassify endpoint
 * we already use elsewhere.
 *
 * Net effect for the bookkeeper:
 *   - Same outcome (transactions auto-categorize per the rule)
 *   - Different mechanism (we apply, not QBO)
 *   - No "pushed to QBO" badge — replaced with "active in SNAP"
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { discovery_job_id } = await request.json();
  if (!discovery_job_id) {
    return NextResponse.json({ error: "discovery_job_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("rule_discovery_jobs")
    .select("*, client_links(*)")
    .eq("id", discovery_job_id)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Idempotency guard — a completed job is already posted; re-running would
  // silently re-mark the rules active and log a duplicate "activated" event.
  // (Matches the reclass/COA execute routes, which already short-circuit.)
  if ((job as any).status === "complete") {
    return NextResponse.json({ started: false, already_complete: true, message: "Rules already activated" });
  }
  if ((job as any).status === "executing") {
    return NextResponse.json({ started: false, message: "Already executing" });
  }

  await service
    .from("rule_discovery_jobs")
    .update({
      status: "executing",
      execution_started_at: new Date().toISOString(),
    } as any)
    .eq("id", discovery_job_id);

  const { data: rules } = await service
    .from("bank_rules")
    .select("id, vendor_pattern, target_account_name")
    .eq("discovery_job_id", discovery_job_id)
    .eq("status", "approved");

  if (!rules || rules.length === 0) {
    await service
      .from("rule_discovery_jobs")
      .update({
        status: "complete",
        execution_completed_at: new Date().toISOString(),
        rules_pushed: 0,
        error_message: "No approved rules to activate.",
      } as any)
      .eq("id", discovery_job_id);
    return NextResponse.json({ error: "No approved rules to push" }, { status: 400 });
  }

  // Activate every approved rule in our engine. Single bulk UPDATE so
  // there's no per-rule loop to fail partway through.
  const ids = rules.map((r: any) => r.id);
  const { error: updErr } = await service
    .from("bank_rules")
    .update({
      status: "active",
      pushed_to_qbo: false,
    } as any)
    .in("id", ids);

  if (updErr) {
    await service
      .from("rule_discovery_jobs")
      .update({
        status: "failed",
        execution_completed_at: new Date().toISOString(),
        error_message: `Activate failed: ${updErr.message}`,
      } as any)
      .eq("id", discovery_job_id);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await service.from("audit_log").insert({
    event_type: "bank_rules_activated",
    user_id: user.id,
    request_payload: {
      discovery_job_id,
      rules_activated: rules.length,
      vendor_patterns: rules.map((r: any) => r.vendor_pattern),
    } as any,
  });

  await service
    .from("rule_discovery_jobs")
    .update({
      status: "complete",
      execution_completed_at: new Date().toISOString(),
      rules_pushed: rules.length,
      error_message: null,
    } as any)
    .eq("id", discovery_job_id);

  return NextResponse.json({
    success: true,
    pushed: rules.length,           // legacy key kept for UI compatibility
    activated: rules.length,
    failed: 0,
    errors: [],
    message:
      `${rules.length} rule${rules.length === 1 ? "" : "s"} activated in SNAP's daily-recon engine. ` +
      `When new transactions sync from QuickBooks, SNAP categorizes them automatically per these rules. ` +
      `(QBO's public API doesn't support creating native bank rules — this is the supported alternative.)`,
  });
}

export const maxDuration = 60;
