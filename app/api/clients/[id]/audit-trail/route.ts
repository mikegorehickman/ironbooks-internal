import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { categorizeAuditEvent, humanizeEventType } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/audit-trail
 *   ?from=YYYY-MM-DD &to=YYYY-MM-DD &user=<uuid> &category=<key> &q=<text>
 *   &limit=<n> &cursor=<iso timestamp>
 *
 * Everything that happened to one client, in one timeline.
 *
 * audit_log alone is not the full record — several things that materially change
 * a client's books live in their own tables and were never written to it. So this
 * merges five sources and labels each event with where it came from, rather than
 * implying audit_log is complete:
 *
 *   audit_log          — the 138 event types (post-migration-145, ~93% attributed)
 *   reclass_jobs       — every categorization run, its scope and outcome
 *   coa_jobs           — every chart cleanup run
 *   daily_recon_runs   — nightly engine runs, with what they pulled and executed
 *   client_email_log   — what we actually sent the client
 *
 * Read-only, admin/lead only, and shaped for an external auditor later: stable
 * event ids, explicit source, ISO timestamps, keyset pagination (so an export can
 * walk the whole history without offset drift), and no aggregation that would
 * hide a row.
 */

const MAX_LIMIT = 500;

export interface TrailEvent {
  /** Stable within a source, so an export can de-duplicate across pages. */
  id: string;
  source: "audit_log" | "reclass_job" | "coa_job" | "daily_recon" | "email";
  occurred_at: string;
  event_type: string;
  label: string;
  category: string;
  user_id: string | null;
  user_name: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await (service as any)
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!["admin", "lead", "owner"].includes(String(role))) {
    return NextResponse.json({ error: "Admins and leads only" }, { status: 403 });
  }

  const { id: clientLinkId } = await ctx.params;
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const userFilter = url.searchParams.get("user");
  const category = url.searchParams.get("category");
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, MAX_LIMIT);
  const cursor = url.searchParams.get("cursor");

  // `to` is a DATE; the caller means "through the end of that day".
  const toExclusive = to ? `${to}T23:59:59.999Z` : null;
  const inWindow = (ts: string | null) =>
    !!ts && (!from || ts >= from) && (!toExclusive || ts <= toExclusive);

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // ── Source 1: audit_log ───────────────────────────────────────────────────
  // Uses the client_link_id COLUMN added by migration 145. Before that column
  // existed this query was impossible — the id lived in JSONB and only 31% of
  // rows carried it.
  let auditQ = (service as any)
    .from("audit_log")
    .select("id, event_type, occurred_at, user_id, request_payload, error_message, status_code")
    .eq("client_link_id", clientLinkId)
    .order("occurred_at", { ascending: false })
    .limit(limit * 2);
  if (from) auditQ = auditQ.gte("occurred_at", from);
  if (toExclusive) auditQ = auditQ.lte("occurred_at", toExclusive);
  if (userFilter) auditQ = auditQ.eq("user_id", userFilter);
  if (cursor) auditQ = auditQ.lt("occurred_at", cursor);
  const { data: auditRows } = await auditQ;

  // ── Sources 2-5: the tables that were never in audit_log ─────────────────
  const [{ data: reclassJobs }, { data: coaJobs }, { data: reconRuns }, { data: emails }] =
    await Promise.all([
      (service as any)
        .from("reclass_jobs")
        .select("id, status, workflow, date_range_start, date_range_end, transactions_pulled, created_at, bookkeeper_id")
        .eq("client_link_id", clientLinkId)
        .order("created_at", { ascending: false })
        .limit(limit),
      (service as any)
        .from("coa_jobs")
        .select("id, status, created_at, error_message, bookkeeper_id")
        .eq("client_link_id", clientLinkId)
        .order("created_at", { ascending: false })
        .limit(limit),
      (service as any)
        .from("daily_recon_runs")
        .select("id, status, run_at, transactions_pulled, auto_executed, queued_for_review, error_message")
        .eq("client_link_id", clientLinkId)
        .order("run_at", { ascending: false })
        .limit(limit),
      (service as any)
        .from("client_email_log")
        .select("id, email_type, subject, to_address, status, created_at, created_by")
        .eq("client_link_id", clientLinkId)
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);

  // ── Resolve user names once ───────────────────────────────────────────────
  const userIds = new Set<string>();
  for (const r of (auditRows as any[]) || []) if (r.user_id) userIds.add(r.user_id);
  for (const j of (reclassJobs as any[]) || []) if (j.bookkeeper_id) userIds.add(j.bookkeeper_id);
  for (const j of (coaJobs as any[]) || []) if (j.bookkeeper_id) userIds.add(j.bookkeeper_id);
  for (const e of (emails as any[]) || []) if (e.created_by) userIds.add(e.created_by);
  const nameById = new Map<string, string>();
  if (userIds.size) {
    const { data: us } = await (service as any)
      .from("users")
      .select("id, full_name, email")
      .in("id", [...userIds]);
    for (const u of (us as any[]) || []) nameById.set(u.id, u.full_name || u.email || "—");
  }

  const events: TrailEvent[] = [];

  for (const r of (auditRows as any[]) || []) {
    const p = r.request_payload || {};
    events.push({
      id: `audit:${r.id}`,
      source: "audit_log",
      occurred_at: r.occurred_at,
      event_type: r.event_type,
      label: humanizeEventType(r.event_type),
      category: categorizeAuditEvent(r.event_type),
      user_id: r.user_id ?? null,
      user_name: r.user_id ? nameById.get(r.user_id) || "—" : "System",
      summary:
        r.error_message
          ? `Failed: ${String(r.error_message).slice(0, 180)}`
          : summarizePayload(p),
      detail: p,
    });
  }

  for (const j of (reclassJobs as any[]) || []) {
    if (!inWindow(j.created_at)) continue;
    events.push({
      id: `reclass:${j.id}`,
      source: "reclass_job",
      occurred_at: j.created_at,
      event_type: "reclass_job",
      label: "Transaction reclass run",
      category: "transactions",
      user_id: j.bookkeeper_id ?? null,
      user_name: j.bookkeeper_id ? nameById.get(j.bookkeeper_id) || "—" : "System",
      summary:
        `${j.workflow || "reclass"} · ${j.date_range_start} → ${j.date_range_end} · ` +
        `${j.transactions_pulled ?? 0} pulled · ${j.status}`,
      detail: j,
    });
  }

  for (const j of (coaJobs as any[]) || []) {
    if (!inWindow(j.created_at)) continue;
    events.push({
      id: `coa:${j.id}`,
      source: "coa_job",
      occurred_at: j.created_at,
      event_type: "coa_job",
      label: "Chart of accounts cleanup",
      category: "chart",
      user_id: j.bookkeeper_id ?? null,
      user_name: j.bookkeeper_id ? nameById.get(j.bookkeeper_id) || "—" : "System",
      summary: `${j.status}${j.error_message ? ` — ${String(j.error_message).slice(0, 140)}` : ""}`,
      detail: j,
    });
  }

  for (const r of (reconRuns as any[]) || []) {
    if (!inWindow(r.run_at)) continue;
    events.push({
      id: `recon:${r.id}`,
      source: "daily_recon",
      occurred_at: r.run_at,
      event_type: "daily_recon_run",
      label: "Daily recon run",
      category: "recon",
      user_id: null,
      user_name: "System",
      summary:
        `${r.transactions_pulled ?? 0} pulled · ${r.auto_executed ?? 0} auto-executed · ` +
        `${r.queued_for_review ?? 0} queued · ${r.status}` +
        (r.error_message ? ` — ${String(r.error_message).slice(0, 120)}` : ""),
      detail: r,
    });
  }

  for (const e of (emails as any[]) || []) {
    if (!inWindow(e.created_at)) continue;
    events.push({
      id: `email:${e.id}`,
      source: "email",
      occurred_at: e.created_at,
      event_type: `email_${e.email_type || "sent"}`,
      label: "Email sent to client",
      category: "client",
      user_id: e.created_by ?? null,
      user_name: e.created_by ? nameById.get(e.created_by) || "—" : "System",
      summary: `${e.subject || "(no subject)"} → ${e.to_address || "—"} · ${e.status || "sent"}`,
      detail: e,
    });
  }

  // ── Merge, filter, paginate ───────────────────────────────────────────────
  let merged = events
    .filter((e) => !!e.occurred_at)
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

  if (userFilter) merged = merged.filter((e) => e.user_id === userFilter);
  if (category) merged = merged.filter((e) => e.category === category);
  if (q) {
    merged = merged.filter((e) =>
      `${e.label} ${e.event_type} ${e.summary} ${e.user_name}`.toLowerCase().includes(q)
    );
  }

  const page = merged.slice(0, limit);
  // Keyset cursor rather than an offset: an offset shifts as new events land, so
  // a long export would silently skip or repeat rows.
  const nextCursor = merged.length > limit ? page[page.length - 1]?.occurred_at ?? null : null;

  return NextResponse.json({
    client: { id: client.id, name: client.client_name },
    window: { from: from ?? null, to: to ?? null },
    counts: {
      returned: page.length,
      by_source: page.reduce<Record<string, number>>((acc, e) => {
        acc[e.source] = (acc[e.source] || 0) + 1;
        return acc;
      }, {}),
    },
    events: page,
    next_cursor: nextCursor,
    // Stated so a reader never mistakes this for the complete record. ~7% of
    // audit_log rows carry no client (master-COA edits, cron summaries) and are
    // fleet-level by nature — see migration 145.
    coverage_note:
      "Merges audit_log with reclass jobs, COA jobs, daily-recon runs and client emails. " +
      "Fleet-level audit events (master COA edits, cron summaries) have no single client " +
      "and are not shown here.",
  });
}

/** Best-effort one-liner from a free-form payload, without inventing detail. */
function summarizePayload(p: Record<string, any>): string {
  if (p.old_name && p.new_name) return `"${p.old_name}" → "${p.new_name}"`;
  if (p.from_account_name && p.to_account_name) return `${p.from_account_name} → ${p.to_account_name}`;
  if (p.message) return String(p.message).slice(0, 180);
  if (p.reason) return String(p.reason).slice(0, 180);
  if (p.changed) return `changed: ${(p.changed as string[]).join(", ")}`;
  const keys = Object.keys(p).filter((k) => !k.endsWith("_id"));
  return keys.length ? keys.slice(0, 5).map((k) => `${k}=${JSON.stringify(p[k])}`).join(" · ").slice(0, 200) : "—";
}
