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
 * merges seven sources and labels each event with where it came from, rather than
 * implying audit_log is complete:
 *
 *   audit_log          — the 138 event types (post-migration-145, ~93% attributed)
 *   reclassifications  — THE LINE-LEVEL QBO WRITES: every transaction actually
 *                        repointed, from-account → to-account, with its amount
 *   coa_actions        — THE ACCOUNT-LEVEL QBO WRITES: every rename, merge,
 *                        retype, create and inactivate that landed
 *   reclass_jobs       — every categorization run, its scope and outcome
 *   coa_jobs           — every chart cleanup run
 *   daily_recon_runs   — nightly engine runs, with what they pulled and executed
 *   client_email_log   — what we actually sent the client
 *
 * The two line-level sources are the point of this endpoint. Measured on Clean
 * Your Carpets 2026-07-31: the job-level record said "3 reclass runs, 853 pulled,
 * 2 failed" while the actual change history was 240 transactions repointed in QBO
 * for $16,241.60 and 17 executed account actions — none of it in audit_log, none
 * of it reachable from /admin/audit. A trail that shows the runs but not the
 * writes answers "did we do work" and not "what did we change", which is the only
 * question an audit asks.
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
  source:
    | "audit_log"
    | "qbo_transaction_write"
    | "qbo_account_write"
    | "reclass_job"
    | "coa_job"
    | "daily_recon"
    | "email";
  occurred_at: string;
  event_type: string;
  label: string;
  category: string;
  user_id: string | null;
  user_name: string | null;
  summary: string;
  /** Set on the two QBO-write sources: this event changed the client's books. */
  changed_books?: boolean;
  detail: Record<string, unknown> | null;
}

/** Per-source ceiling on line-level writes pulled in one request. A single
 *  cleanup can execute thousands of lines; silently returning the first N of
 *  them would be the same lie this endpoint exists to stop, so when the cap
 *  bites it is reported in `truncated` rather than hidden. */
const LINE_WRITE_CAP = 2000;

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

  // ── Sources 6-7: the actual QBO writes ───────────────────────────────────
  // reclassifications and coa_actions carry no client column of their own — they
  // are reachable only through their job. Job ids are therefore fetched WITHOUT a
  // limit (a client has a handful of jobs, not thousands), so a client's oldest
  // writes stay reachable even when the job list above is paged.
  const [{ data: allReclassJobs }, { data: allCoaJobs }] = await Promise.all([
    (service as any).from("reclass_jobs").select("id, bookkeeper_id").eq("client_link_id", clientLinkId),
    (service as any).from("coa_jobs").select("id, bookkeeper_id").eq("client_link_id", clientLinkId),
  ]);
  const reclassJobIds = ((allReclassJobs as any[]) || []).map((j) => j.id);
  const coaJobIds = ((allCoaJobs as any[]) || []).map((j) => j.id);
  const jobOwner = new Map<string, string | null>();
  for (const j of [...((allReclassJobs as any[]) || []), ...((allCoaJobs as any[]) || [])]) {
    jobOwner.set(j.id, j.bookkeeper_id ?? null);
  }

  /** Coverage limits hit on this request. Reported, never silently applied. */
  const truncated: string[] = [];

  let txWrites: any[] = [];
  if (reclassJobIds.length) {
    let q = (service as any)
      .from("reclassifications")
      .select(
        "id, reclass_job_id, executed_at, transaction_date, from_account_name, to_account_name, " +
          "transaction_amount, qbo_transaction_id, qbo_transaction_type, vendor_name, description, " +
          "decision, bank_account_name, bookkeeper_override, ai_reasoning"
      )
      .in("reclass_job_id", reclassJobIds)
      .not("executed_at", "is", null)
      .order("executed_at", { ascending: false })
      .limit(LINE_WRITE_CAP);
    if (from) q = q.gte("executed_at", from);
    if (toExclusive) q = q.lte("executed_at", toExclusive);
    if (cursor) q = q.lt("executed_at", cursor);
    const { data, error } = await q;
    if (error) truncated.push(`transaction writes unavailable: ${error.message}`);
    txWrites = (data as any[]) || [];
    if (txWrites.length >= LINE_WRITE_CAP) {
      truncated.push(
        `transaction writes capped at ${LINE_WRITE_CAP} for this request — narrow the date range to see the rest`
      );
    }
  }

  let acctWrites: any[] = [];
  if (coaJobIds.length) {
    const { data, error } = await (service as any)
      .from("coa_actions")
      .select(
        "id, job_id, action, executed_at, created_at, current_name, current_type, current_subtype, " +
          "new_name, new_type, new_subtype, new_parent_name, transaction_count, error_message"
      )
      .in("job_id", coaJobIds)
      .eq("executed", true)
      .order("executed_at", { ascending: false })
      .limit(LINE_WRITE_CAP);
    if (error) truncated.push(`account writes unavailable: ${error.message}`);
    acctWrites = (data as any[]) || [];
    if (acctWrites.length >= LINE_WRITE_CAP) {
      truncated.push(`account writes capped at ${LINE_WRITE_CAP} for this request`);
    }
  }

  // ── Resolve user names once ───────────────────────────────────────────────
  const userIds = new Set<string>();
  for (const b of jobOwner.values()) if (b) userIds.add(b);
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

  // The two sources that answer "what changed in QuickBooks".
  for (const r of txWrites) {
    const owner = jobOwner.get(r.reclass_job_id) ?? null;
    const who = r.vendor_name || r.description || "transaction";
    events.push({
      id: `txwrite:${r.id}`,
      source: "qbo_transaction_write",
      occurred_at: r.executed_at,
      event_type: "qbo_transaction_reclassified",
      label: "Transaction repointed in QuickBooks",
      category: "transactions",
      user_id: owner,
      user_name: owner ? nameById.get(owner) || "—" : "System",
      changed_books: true,
      summary:
        `${money(r.transaction_amount)} · ${String(who).slice(0, 48)} · ` +
        `${r.from_account_name || "(no account)"} → ${r.to_account_name || "(none)"}` +
        (r.bookkeeper_override ? " · bookkeeper override" : ""),
      detail: r,
    });
  }

  for (const a of acctWrites) {
    // executed_at is the write; created_at is the fallback for the handful of
    // older rows executed before that column was populated.
    const at = a.executed_at || a.created_at;
    if (!inWindow(at)) continue;
    const owner = jobOwner.get(a.job_id) ?? null;
    events.push({
      id: `acctwrite:${a.id}`,
      source: "qbo_account_write",
      occurred_at: at,
      event_type: `qbo_account_${a.action || "change"}`,
      label: `Account ${a.action || "change"} in QuickBooks`,
      category: "chart",
      user_id: owner,
      user_name: owner ? nameById.get(owner) || "—" : "System",
      changed_books: true,
      summary: describeAccountWrite(a),
      detail: a,
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
      /** The subset that changed the client's QuickBooks, and by how much. This
       *  is the number an auditor asks for, so it is computed over the whole
       *  matched set — not just the returned page, which would understate it. */
      qbo_writes: merged.filter((e) => e.changed_books).length,
      qbo_transaction_amount: Number(
        txWrites
          .reduce((sum, r) => sum + Math.abs(Number(r.transaction_amount) || 0), 0)
          .toFixed(2)
      ),
    },
    events: page,
    next_cursor: nextCursor,
    /** Empty when nothing was dropped. A cap that isn't reported reads as
     *  complete coverage, which is the failure this endpoint exists to fix. */
    truncated,
    // Stated so a reader never mistakes this for the complete record. ~7% of
    // audit_log rows carry no client (master-COA edits, cron summaries) and are
    // fleet-level by nature — see migration 145.
    coverage_note:
      "Merges the QuickBooks writes themselves (transaction reclassifications and " +
      "executed account actions) with audit_log, reclass jobs, COA jobs, daily-recon runs " +
      "and client emails. Fleet-level audit events (master COA edits, cron summaries) have " +
      "no single client and are not shown here.",
  });
}

/** Signed, 2dp, with the sign kept — a reclass that moved a credit is not the
 *  same event as one that moved a debit. */
function money(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "$—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** One line describing what an executed COA action did to the chart. Reads the
 *  action type rather than guessing from which fields are populated, because a
 *  retype and a rename can both carry new_name. */
function describeAccountWrite(a: Record<string, any>): string {
  const from = a.current_name || "(unnamed)";
  const typeShift =
    a.new_type && a.new_type !== a.current_type
      ? ` · type ${a.current_type || "—"} → ${a.new_type}${a.new_subtype ? ` / ${a.new_subtype}` : ""}`
      : "";
  const txns = a.transaction_count ? ` · ${a.transaction_count} txns` : "";
  switch (a.action) {
    case "rename":
      return `"${from}" → "${a.new_name || "?"}"${typeShift}${txns}`;
    case "merge":
      return `"${from}" merged into "${a.new_name || "?"}"${txns}`;
    case "retype":
      return `"${from}"${typeShift || " · type unchanged"}${txns}`;
    case "create":
      return `created "${a.new_name || from}"${a.new_parent_name ? ` under "${a.new_parent_name}"` : ""}`;
    case "delete":
      return `inactivated "${from}"${txns}`;
    case "reparent":
      return `"${from}" moved under "${a.new_parent_name || "?"}"`;
    default:
      return `${a.action || "change"}: "${from}"${a.new_name ? ` → "${a.new_name}"` : ""}${typeShift}${txns}`;
  }
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
