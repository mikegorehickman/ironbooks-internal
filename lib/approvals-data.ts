import type { SupabaseClient } from "@supabase/supabase-js";
import type { StatementApprovalRow } from "@/app/today/statement-approvals-widget";
import type { StatementEscalationRow } from "@/app/today/statement-escalations-widget";

export interface ManagerReviewRow {
  id: string;
  client_name: string;
  submitted_at: string | null;
  submitted_by: string | null;
}

export interface ScoreOverrideRow {
  client_link_id: string;
  client_name: string;
  period: string;
  score: number;
  reason: string;
  overridden_by_name: string;
  at: string;
}

export interface ApprovalQueues {
  managerReviewRows: ManagerReviewRow[];
  statementApprovals: StatementApprovalRow[];
  statementEscalations: StatementEscalationRow[];
  scoreOverrides: ScoreOverrideRow[];
}

/**
 * The manager's daily-production approval queues — extracted from /today so they
 * live on the dedicated Production → Approvals page (and /today stays a lean
 * personal action queue). Senior-only content; returns empty arrays otherwise.
 *   1. Files submitted for manager review (cleanup_review_state='in_review')
 *   2. Statements awaiting senior approval (monthly_rec_runs status='pending_review')
 *   3. Statements a bookkeeper escalated as wrong (audit_log, last 30d, minus resolved)
 */
export async function getApprovalQueues(
  service: SupabaseClient,
  opts: { isSenior: boolean; viewAs?: string | null }
): Promise<ApprovalQueues> {
  const { isSenior, viewAs = null } = opts;
  if (!isSenior) {
    return { managerReviewRows: [], statementApprovals: [], statementEscalations: [], scoreOverrides: [] };
  }
  const svc = service as any;

  // 1. Manager review queue
  let managerReviewRows: ManagerReviewRow[] = [];
  try {
    let revQuery = svc
      .from("client_links")
      .select("id, client_name, cleanup_review_submitted_at, cleanup_review_submitted_by, assigned_bookkeeper_id")
      .eq("is_active", true)
      .eq("cleanup_review_state", "in_review");
    if (viewAs) revQuery = revQuery.eq("assigned_bookkeeper_id", viewAs);
    const rev = ((await revQuery).data as any[]) || [];
    const subIds = [...new Set(rev.map((r) => r.cleanup_review_submitted_by).filter(Boolean))];
    const nameById = new Map<string, string>();
    if (subIds.length) {
      const { data: us } = await svc.from("users").select("id, full_name").in("id", subIds);
      for (const u of ((us as any[]) || [])) nameById.set(u.id, u.full_name);
    }
    managerReviewRows = rev
      .map((r) => ({
        id: r.id,
        client_name: r.client_name,
        submitted_at: r.cleanup_review_submitted_at ?? null,
        submitted_by: r.cleanup_review_submitted_by ? (nameById.get(r.cleanup_review_submitted_by) || null) : null,
      }))
      .sort((a, b) => (a.submitted_at || "").localeCompare(b.submitted_at || ""));
  } catch {
    managerReviewRows = [];
  }

  // 2. Statements awaiting senior approval
  let statementApprovals: StatementApprovalRow[] = [];
  try {
    const { data: pend } = await svc
      .from("monthly_rec_runs")
      .select("client_link_id, period, kind, submitted_by, submitted_at, has_concerns, concerns, verification_score")
      .eq("status", "pending_review")
      .order("submitted_at", { ascending: true });
    const raw = (pend as any[]) || [];
    if (raw.length > 0) {
      const cIds = [...new Set(raw.map((r) => r.client_link_id))];
      const uIds = [...new Set(raw.map((r) => r.submitted_by).filter(Boolean))];
      const [{ data: cn }, { data: un }] = await Promise.all([
        svc.from("client_links").select("id, client_name").in("id", cIds),
        uIds.length > 0
          ? svc.from("users").select("id, full_name, email").in("id", uIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const nameById = new Map(((cn as any[]) || []).map((c) => [c.id, c.client_name]));
      const userById = new Map(((un as any[]) || []).map((u) => [u.id, u.full_name || u.email]));
      statementApprovals = raw.map((r) => ({
        client_link_id: r.client_link_id,
        client_name: nameById.get(r.client_link_id) || "(unknown client)",
        period: r.period,
        kind: r.kind === "cleanup" ? "cleanup" : "production_me",
        submitted_by_name: userById.get(r.submitted_by) || "",
        submitted_at: r.submitted_at,
        has_concerns: !!r.has_concerns,
        concerns: r.concerns,
        verification_score: r.verification_score ?? null,
      })) as StatementApprovalRow[];
    }
  } catch {
    statementApprovals = [];
  }

  // 3. Statements escalated as wrong (last 30 days, minus resolved/hidden)
  let statementEscalations: StatementEscalationRow[] = [];
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: esc } = await svc
      .from("audit_log")
      .select("occurred_at, request_payload")
      .eq("event_type", "statements_escalated")
      .gte("occurred_at", cutoff)
      .order("occurred_at", { ascending: false })
      .limit(50);
    const mapped = ((esc as any[]) || []).map((r) => ({
      item_key: `escalation:${r.request_payload?.client_link_id || ""}:${r.occurred_at}`,
      client_link_id: r.request_payload?.client_link_id || "",
      client_name: r.request_payload?.client_name || "(unknown client)",
      note: r.request_payload?.note || "",
      escalated_by_name: r.request_payload?.escalated_by_name || "",
      at: r.occurred_at,
      due_date: null as string | null,
    })).filter((r) => r.client_link_id);

    const keys = mapped.map((m) => m.item_key);
    let overrides = new Map<string, any>();
    if (keys.length > 0) {
      const { data: ov } = await svc
        .from("today_item_overrides")
        .select("item_key, resolved_at, hidden_at, due_date")
        .in("item_key", keys);
      overrides = new Map(((ov as any[]) || []).map((o) => [o.item_key, o]));
    }
    statementEscalations = mapped
      .filter((m) => {
        const o = overrides.get(m.item_key);
        return !o?.resolved_at && !o?.hidden_at;
      })
      .map((m) => ({ ...m, due_date: overrides.get(m.item_key)?.due_date || null }))
      .sort((a, b) => {
        if (a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : 1;
        if (a.due_date) return -1;
        if (b.due_date) return 1;
        return a.at < b.at ? 1 : -1;
      }) as StatementEscalationRow[];
  } catch {
    statementEscalations = [];
  }

  // 4. Below-threshold sends (Books Reliability overrides, last 30 days) —
  //    complete transparency on what went out under the bar, who, and why.
  let scoreOverrides: ScoreOverrideRow[] = [];
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: ovr } = await svc
      .from("monthly_rec_runs")
      .select("client_link_id, period, verification_override, completed_at, completed_by")
      .eq("status", "complete")
      .not("verification_override", "is", null)
      .gte("completed_at", cutoff)
      .order("completed_at", { ascending: false })
      .limit(50);
    const rows = (ovr as any[]) || [];
    if (rows.length > 0) {
      const cIds = [...new Set(rows.map((r) => r.client_link_id))];
      const uIds = [...new Set(rows.map((r) => r.verification_override?.by).filter(Boolean))];
      const [{ data: cn }, { data: un }] = await Promise.all([
        svc.from("client_links").select("id, client_name").in("id", cIds),
        uIds.length > 0
          ? svc.from("users").select("id, full_name, email").in("id", uIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const nameById = new Map(((cn as any[]) || []).map((c) => [c.id, c.client_name]));
      const userById = new Map(((un as any[]) || []).map((u) => [u.id, u.full_name || u.email]));
      scoreOverrides = rows.map((r) => ({
        client_link_id: r.client_link_id,
        client_name: nameById.get(r.client_link_id) || "(unknown client)",
        period: r.period,
        score: Number(r.verification_override?.score_at_override ?? 0),
        reason: String(r.verification_override?.reason || ""),
        overridden_by_name: userById.get(r.verification_override?.by) || "",
        at: r.verification_override?.at || r.completed_at,
      }));
    }
  } catch {
    scoreOverrides = [];
  }

  return { managerReviewRows, statementApprovals, statementEscalations, scoreOverrides };
}
