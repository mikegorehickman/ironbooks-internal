import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/jobs/[id]/error-report
 *
 * Generates a Claude-friendly markdown debug report for a failed or
 * stuck COA cleanup job. Includes the job config, every audit_log event
 * in chronological order, all coa_actions and their final states,
 * manual cleanup items, and the error message.
 *
 * Bookkeeper downloads this and pastes the contents into Claude when
 * asking for help diagnosing / fixing the underlying issue.
 *
 * No mutations — pure read.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const [jobRes, actionsRes, eventsRes, bookkeeperRes] = await Promise.all([
    service
      .from("coa_jobs")
      .select("*, client_links(client_name, jurisdiction, state_province, industry, qbo_realm_id)")
      .eq("id", jobId)
      .single(),
    service
      .from("coa_actions")
      .select("*")
      .eq("job_id", jobId)
      .order("sort_order"),
    service
      .from("audit_log")
      .select("occurred_at, event_type, request_payload, response_payload, action_id")
      .eq("job_id", jobId)
      .order("occurred_at", { ascending: true })
      .limit(1000),
    null, // placeholder
  ]);

  if (jobRes.error || !jobRes.data) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  const job: any = jobRes.data;
  const client = (job as any).client_links;
  const actions: any[] = actionsRes.data || [];
  const events: any[] = eventsRes.data || [];

  // Look up bookkeeper name
  let bookkeeperName = "Unknown bookkeeper";
  if (job.bookkeeper_id) {
    const { data: bk } = await service
      .from("users")
      .select("full_name")
      .eq("id", job.bookkeeper_id)
      .single();
    if (bk?.full_name) bookkeeperName = bk.full_name;
    void bookkeeperRes;
  }

  // ─── Build the markdown report ───
  const md: string[] = [];

  md.push(`# Ironbooks COA Cleanup — Error Report`);
  md.push(``);
  md.push(`> Generated for Claude on ${new Date().toISOString()}. Paste this entire document into a Claude conversation along with "what went wrong and how do I fix the code" to get a focused diagnosis.`);
  md.push(``);
  md.push(`## Job summary`);
  md.push(``);
  md.push(`- **Job ID**: \`${job.id}\``);
  md.push(`- **Client**: ${client?.client_name || "?"} (realm \`${client?.qbo_realm_id || "?"}\`)`);
  md.push(`- **Jurisdiction**: ${client?.jurisdiction || "?"}${client?.state_province ? " · " + client.state_province : ""}`);
  md.push(`- **Industry**: ${client?.industry || "?"}`);
  md.push(`- **Bookkeeper**: ${bookkeeperName}`);
  md.push(`- **Status**: \`${job.status}\``);
  md.push(`- **Date range**: ${job.date_range_start || "(unset)"} → ${job.date_range_end || "(unset)"}  (preset: \`${job.date_range_preset || "—"}\`)`);
  md.push(`- **Created**: ${job.created_at}`);
  md.push(`- **Execution started**: ${job.execution_started_at || "—"}`);
  md.push(`- **Execution completed**: ${job.execution_completed_at || "—"}`);
  md.push(`- **Duration**: ${job.execution_duration_seconds ?? "—"} seconds`);
  md.push(`- **Error message**: ${job.error_message ? `\n\n\`\`\`\n${job.error_message}\n\`\`\`` : "—"}`);
  md.push(``);

  // Action counts
  const counts: Record<string, number> = {};
  const executedCounts: Record<string, number> = {};
  for (const a of actions) {
    counts[a.action] = (counts[a.action] || 0) + 1;
    if (a.executed) executedCounts[a.action] = (executedCounts[a.action] || 0) + 1;
  }
  md.push(`## Action counts`);
  md.push(``);
  md.push(`| Action | Total | Executed |`);
  md.push(`|---|---|---|`);
  for (const t of ["create", "rename", "merge", "delete", "flag", "keep"]) {
    if (counts[t] || executedCounts[t]) {
      md.push(`| ${t} | ${counts[t] || 0} | ${executedCounts[t] || 0} |`);
    }
  }
  md.push(``);

  // Manual cleanup items
  const manual = (job.manual_cleanup_items as any[]) || [];
  if (manual.length > 0) {
    md.push(`## Manual cleanup items (${manual.length})`);
    md.push(``);
    for (const item of manual.slice(0, 25)) {
      md.push(`- **${item.account_name || "?"}** (${item.intended_action || "?"})`);
      if (item.reason) md.push(`  - Reason: ${item.reason}`);
      if (item.suggestion) md.push(`  - Suggestion: ${item.suggestion}`);
      if (item.qbo_response) md.push(`  - QBO response: \`${item.qbo_response}\``);
    }
    if (manual.length > 25) md.push(`- _(${manual.length - 25} more not shown)_`);
    md.push(``);
  }

  // Failed actions (executed=false with error_message OR flagged_reason)
  const failedActions = actions.filter(
    (a) => !a.executed && (a.error_message || a.flagged_reason)
  );
  if (failedActions.length > 0) {
    md.push(`## Failed / flagged actions (${failedActions.length})`);
    md.push(``);
    for (const a of failedActions.slice(0, 30)) {
      md.push(`- **${a.current_name || a.new_name || a.qbo_account_id}** — \`${a.action}\``);
      if (a.new_name && a.current_name && a.new_name !== a.current_name)
        md.push(`  - Target: \`${a.new_name}\``);
      if (a.error_message) md.push(`  - Error: \`${String(a.error_message).slice(0, 500)}\``);
      if (a.flagged_reason) md.push(`  - Flag reason: ${String(a.flagged_reason).slice(0, 500)}`);
      if (a.ai_reasoning) md.push(`  - AI reasoning: ${String(a.ai_reasoning).slice(0, 200)}`);
    }
    if (failedActions.length > 30) md.push(`- _(${failedActions.length - 30} more not shown)_`);
    md.push(``);
  }

  // Successful actions (concise)
  const completedActions = actions.filter((a) => a.executed);
  if (completedActions.length > 0) {
    md.push(`## Completed actions (${completedActions.length})`);
    md.push(``);
    for (const a of completedActions.slice(0, 40)) {
      const transform =
        a.action === "rename"
          ? `${a.current_name} → ${a.new_name}`
          : a.action === "merge"
          ? `${a.current_name} →MERGE→ ${a.new_name}`
          : a.action === "create"
          ? `+ ${a.new_name}`
          : a.action === "delete"
          ? `inactivate ${a.current_name}`
          : a.current_name || a.new_name || "?";
      md.push(`- \`${a.action}\` · ${transform}`);
    }
    if (completedActions.length > 40) md.push(`- _(${completedActions.length - 40} more not shown)_`);
    md.push(``);
  }

  // Audit log — every event
  md.push(`## Audit log (chronological, ${events.length} events)`);
  md.push(``);
  for (const e of events) {
    const msg =
      e.request_payload?.message ||
      e.request_payload?.reason ||
      e.event_type;
    const ts = e.occurred_at?.slice(11, 19) || "—"; // HH:MM:SS
    md.push(`- \`${ts}\` **${e.event_type}** — ${String(msg).slice(0, 280)}`);
  }
  md.push(``);

  // Pending failures — the structured data we feed Claude for repair
  if (Array.isArray(job.pending_failures) && job.pending_failures.length > 0) {
    md.push(`## Pending failures (raw, for repair-plan AI)`);
    md.push(``);
    md.push("```json");
    md.push(JSON.stringify(job.pending_failures, null, 2).slice(0, 8000));
    md.push("```");
    md.push(``);
  }

  // Suggested questions for Claude
  md.push(`## What to ask Claude`);
  md.push(``);
  md.push(`1. Look at the audit log + failed actions. What's the most likely root cause of the failures?`);
  md.push(`2. Are there any patterns (same error message across multiple actions, same stage)?`);
  md.push(`3. Should this be a code change (executor / executor stage / validation) or a data change (re-pick scope, run partial-merge with rename, etc.)?`);
  md.push(`4. If code change: what file + function + ~lines?`);
  md.push(``);
  md.push(`---`);
  md.push(`_Report ends._`);

  const body = md.join("\n");
  const safeClient = (client?.client_name || "Client").replace(/[^A-Za-z0-9 .\-_]+/g, "").trim();
  const asciiFilename = `Ironbooks Error Report - ${safeClient} - ${jobId.slice(0, 8)}.md`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${asciiFilename}"`,
      "Cache-Control": "no-store",
    },
  });
}
