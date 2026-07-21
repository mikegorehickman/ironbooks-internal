import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboErrorResponse, updateClosingDate } from "@/lib/qbo";
import {
  aiSpotCheckStatements,
  fetchStatementsPreview,
  previousMonthPeriod,
  runMonthlyRecChecks,
} from "@/lib/monthly-rec";
import { emailPortalUsersAboutMessage } from "@/lib/client-comms";
import {
  runBooksVerification,
  recomputeStoredVerification,
  SEND_MIN_SCORE,
  openRedFlags,
  type DismissalRow,
  type VerificationResult,
} from "@/lib/books-verification";
import { buildPackagesBulk } from "@/lib/month-end/package-builder";
import { generateSummariesBatch } from "@/lib/month-end/generate-summaries";
import { bulkApproveSummaries } from "@/lib/month-end/bulk-approve";
import { deliverPackagesBulk } from "@/lib/month-end/send";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ── TEMPORARY: manager-review gate (Mike, 2026-07-10) ───────────────────────
// Kedma reviews before this month's PRODUCTION P&Ls go out (kind !==
// "cleanup" — new-client cleanup sign-off is a different queue and stays
// untouched). Fails OPEN (no gate) if this account can't be found, so a typo
// or a deactivated account never freezes sends for the whole team.
//
// TO REMOVE once no longer needed: delete this const + the gate block inside
// the "send"/"mark_complete" handler below (search MANAGER_REVIEW_EMAIL).
// Migration 113's 3 columns are harmless to leave unused.
const MANAGER_REVIEW_EMAIL = "kedma@ironbooks.com";

/**
 * POST /api/clients/[id]/monthly-rec
 *
 * Body:
 *   { action: "run",        period?: "YYYY-MM" }
 *       → run the read-only QBO checks for the month, upsert the run row.
 *   { action: "statements", period?: "YYYY-MM" }
 *       → fetch the financial statements (P&L for the period + BS as of
 *         period end), snapshot them on the run, return for review.
 *   { action: "send",       period?: "YYYY-MM", attested: true, concerns?: string }
 *       → THE CLOSE GATE. Requires checks run + statements reviewed +
 *         explicit attestation. Marks the month complete, notifies the
 *         client in their portal (red badge + chime) and emails them.
 *   { action: "reopen",     period?: "YYYY-MM" }
 *       → flip a completed month back to open.
 *
 * Auth: assigned bookkeeper or admin/lead.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("*")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Balance Sheet toggle: false = P&L-only monthly service while the BS
  // cleanup finishes. Missing column (pre-migration 66) reads as enabled.
  const includeBS = (client as any).bs_enabled !== false;

  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    action?: string;
    period?: string;
    concerns?: string;
    attested?: boolean;
    /** What the senior attested: "pl" = P&L only, "pl_bs" = P&L + Balance Sheet. */
    attest_scope?: "pl" | "pl_bs" | "";
    board_status?: string;
    waiting_reasons?: string[];
    status_note?: string;
    /** Books Reliability gate: senior's reason for sending below threshold. */
    override_reason?: string;
    /** TEMPORARY manager-review gate: reason for sending without Kedma's sign-off. */
    manager_override_reason?: string;
    /** dismiss_finding / undismiss_finding */
    check_key?: string;
    fingerprint?: string;
    reason?: string;
    /** send_draft: the question for the client. */
    question?: string;
    /** reject: manager's note on what to fix. */
    notes?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body.action;
  if (!["run", "statements", "spot_check", "submit", "send", "send_draft", "reopen", "reject", "board", "mark_complete", "verify", "dismiss_finding", "undismiss_finding"].includes(action || "")) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  // What the senior attested — "pl_bs" (P&L + Balance Sheet) or "pl" (P&L
  // only, e.g. BS not yet reconciled or a P&L-only-service client). Defaults
  // to "pl_bs" for older clients that send attested:true without a scope.
  const attestScope: "pl" | "pl_bs" =
    body.attest_scope === "pl" ? "pl" : "pl_bs";

  // Resolve the period (default: previous calendar month)
  const def = previousMonthPeriod();
  let period = def.period;
  let periodStart = def.periodStart;
  let periodEnd = def.periodEnd;
  if (body.period && /^\d{4}-\d{2}$/.test(body.period)) {
    period = body.period;
    const [y, m] = period.split("-").map(Number);
    periodStart = `${period}-01`;
    periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }

  if (action === "run") {
    try {
      const accessToken = await getValidToken(clientLinkId, service as any);

      // Green lights (Mike, 2026-07-13): daily queue clear + statements
      // reconciled — the two checks that make month-end a glance.
      const extraChecks: import("@/lib/monthly-rec").MonthlyRecCheck[] = [];
      {
        const { count: qPending } = await (service as any)
          .from("daily_review_queue")
          .select("*", { count: "exact", head: true })
          .eq("client_link_id", clientLinkId)
          .eq("decision", "pending");
        extraChecks.push({
          key: "daily_queue_clear",
          label: "Daily review queue",
          status: !qPending ? "pass" : qPending <= 5 ? "warn" : "fail",
          detail: !qPending
            ? "Queue is clear — every daily transaction handled"
            : `${qPending} transaction${qPending === 1 ? "" : "s"} still waiting in the daily review queue`,
          count: qPending || 0,
          amount: 0,
          fix: qPending ? "daily_queue" : undefined,
        });
        const { data: stmts } = await (service as any)
          .from("client_statements")
          .select("recon_status, recon_variance, matched_account_name, statement_end_date")
          .eq("client_link_id", clientLinkId)
          .gte("statement_end_date", periodStart)
          .lte("statement_end_date", periodEnd);
        const variances = (stmts || []).filter((x: any) => x.recon_status === "variance");
        const reconciled = (stmts || []).filter((x: any) => x.recon_status === "reconciled");
        extraChecks.push({
          key: "statements_reconciled",
          label: "Statement reconciliation",
          status: variances.length > 0 ? "fail" : reconciled.length > 0 ? "pass" : "warn",
          detail: variances.length > 0
            ? `${variances.length} statement${variances.length === 1 ? "" : "s"} don't tie out: ` +
              variances.slice(0, 3).map((v: any) => `${v.matched_account_name || "?"} off by $${Number(v.recon_variance ?? 0).toFixed(2)}`).join("; ")
            : reconciled.length > 0
            ? `${reconciled.length} statement${reconciled.length === 1 ? "" : "s"} match QuickBooks (within $5)`
            : "No reconciled statements on file for this month yet — check the client's statement requests",
          count: variances.length,
          amount: variances.reduce((s2: number, v: any) => s2 + Math.abs(Number(v.recon_variance ?? 0)), 0),
          fix: variances.length > 0 ? "statements" : undefined,
        });
      }

      const result = await runMonthlyRecChecks(
        (client as any).qbo_realm_id,
        accessToken,
        periodStart,
        periodEnd,
        { includeBS, extraChecks }
      );
      const { data: run, error } = await (service as any)
        .from("monthly_rec_runs")
        .upsert(
          {
            client_link_id: clientLinkId,
            period,
            period_start: periodStart,
            period_end: periodEnd,
            checks: result,
            checks_ran_at: new Date().toISOString(),
            created_by: user.id,
          },
          { onConflict: "client_link_id,period" }
        )
        .select("*")
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, run });
    } catch (err: any) {
      return qboErrorResponse(err);
    }
  }

  if (action === "verify") {
    // Books Reliability verification — read-only against QBO, deterministic
    // score, snapshot stored on the run row (re-verify overwrites).
    try {
      const { data: existingRun } = await (service as any)
        .from("monthly_rec_runs")
        .select("kind")
        .eq("client_link_id", clientLinkId)
        .eq("period", period)
        .maybeSingle();
      const accessToken = await getValidToken(clientLinkId, service as any);
      const result = await runBooksVerification({
        service: service as any,
        clientLinkId,
        realmId: (client as any).qbo_realm_id,
        accessToken,
        period,
        periodStart,
        periodEnd,
        includeBS,
        kind: (existingRun?.kind as any) || "production_me",
        ranBy: user.id,
      });
      const { data: run, error } = await (service as any)
        .from("monthly_rec_runs")
        .upsert(
          {
            client_link_id: clientLinkId,
            period,
            period_start: periodStart,
            period_end: periodEnd,
            verification: result,
            verification_score: result.score,
            verification_ran_at: result.ranAt,
            created_by: user.id,
          },
          { onConflict: "client_link_id,period" }
        )
        .select("*")
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, run });
    } catch (err: any) {
      return qboErrorResponse(err);
    }
  }

  if (action === "dismiss_finding" || action === "undismiss_finding") {
    // Accept/revoke a known finding for this client. Pure recompute over the
    // stored snapshot — no QBO calls, so the score updates instantly.
    const fingerprint = (body.fingerprint || "").trim();
    if (!fingerprint) return NextResponse.json({ error: "fingerprint required" }, { status: 400 });

    const { data: run } = await (service as any)
      .from("monthly_rec_runs")
      .select("id, verification, kind")
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .maybeSingle();
    const stored = run?.verification as VerificationResult | null;
    if (!run || !stored) {
      return NextResponse.json({ error: "Run Verify books for this month first." }, { status: 400 });
    }

    if (action === "dismiss_finding") {
      const reason = (body.reason || "").trim();
      if (!reason) return NextResponse.json({ error: "A reason is required to dismiss a finding." }, { status: 400 });
      const finding = stored.checks.flatMap((c) => c.findings).find((f) => f.fingerprint === fingerprint);
      if (!finding) return NextResponse.json({ error: "Finding not found in the current verification." }, { status: 404 });
      if (!finding.dismissable) {
        return NextResponse.json({ error: "This finding can't be dismissed — it has to be fixed." }, { status: 400 });
      }
      if (finding.senior_only && !isSenior) {
        return NextResponse.json({ error: "Only an admin or lead can dismiss this finding." }, { status: 403 });
      }
      const { error: dErr } = await (service as any).from("verification_dismissals").upsert(
        {
          client_link_id: clientLinkId,
          check_key: (body.check_key || fingerprint.split(":")[0] || "").slice(0, 100),
          fingerprint,
          reason: reason.slice(0, 1000),
          detail_snapshot: finding,
          dismissed_by: user.id,
          dismissed_at: new Date().toISOString(),
          active: true,
          revoked_by: null,
          revoked_at: null,
        },
        { onConflict: "client_link_id,fingerprint" }
      );
      if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });
    } else {
      const { error: rErr } = await (service as any)
        .from("verification_dismissals")
        .update({ active: false, revoked_by: user.id, revoked_at: new Date().toISOString() })
        .eq("client_link_id", clientLinkId)
        .eq("fingerprint", fingerprint);
      if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
    }

    // Recompute the stored score against the new dismissal set.
    const { data: dRows } = await (service as any)
      .from("verification_dismissals")
      .select("check_key, fingerprint, reason, dismissed_at, active")
      .eq("client_link_id", clientLinkId)
      .eq("active", true);
    const dismissals: DismissalRow[] = ((dRows as any[]) || []).map((d) => ({
      ...d,
      dismissed_by_name: null,
    }));
    const recomputed = recomputeStoredVerification(stored, dismissals, includeBS);
    const { data: updated, error: uErr } = await (service as any)
      .from("monthly_rec_runs")
      .update({ verification: recomputed, verification_score: recomputed.score })
      .eq("id", run.id)
      .select("*")
      .single();
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, run: updated });
  }

  if (action === "statements") {
    try {
      const accessToken = await getValidToken(clientLinkId, service as any);
      const statements = await fetchStatementsPreview(
        (client as any).qbo_realm_id,
        accessToken,
        periodStart,
        periodEnd,
        { includeBS, revenueMode: (client as any).revenue_recognition_mode }
      );
      const { data: run, error } = await (service as any)
        .from("monthly_rec_runs")
        .upsert(
          {
            client_link_id: clientLinkId,
            period,
            period_start: periodStart,
            period_end: periodEnd,
            statements,
            created_by: user.id,
          },
          { onConflict: "client_link_id,period" }
        )
        .select("*")
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, run });
    } catch (err: any) {
      return qboErrorResponse(err);
    }
  }

  if (action === "board") {
    // Production board move: not_started / in_progress / stuck /
    // waiting_client (+ reason checkboxes + note). "Ready for manager
    // review" is NOT a board status — that's the submit action.
    const VALID_BOARD = ["not_started", "in_progress", "stuck", "waiting_client", "ready_for_review"];
    const VALID_REASONS = ["waiting_reply", "waiting_statements", "disconnected_feed"];
    const boardStatus = String(body.board_status || "");
    if (!VALID_BOARD.includes(boardStatus)) {
      return NextResponse.json({ error: "Invalid board_status" }, { status: 400 });
    }
    const reasons = (Array.isArray(body.waiting_reasons) ? body.waiting_reasons : [])
      .filter((r) => VALID_REASONS.includes(String(r)));
    const note = (body.status_note || "").trim().slice(0, 300) || null;

    const { data: existing } = await (service as any)
      .from("monthly_rec_runs")
      .select("id, status")
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .maybeSingle();
    if (existing?.status === "complete") {
      return NextResponse.json({ error: "This month is already closed." }, { status: 409 });
    }
    const { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .upsert(
        {
          client_link_id: clientLinkId,
          period,
          period_start: periodStart,
          period_end: periodEnd,
          board_status: boardStatus,
          waiting_reasons: boardStatus === "waiting_client" ? reasons : [],
          status_note: note,
          created_by: user.id,
        },
        { onConflict: "client_link_id,period" }
      )
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, run });
  }

  // NOTE: "mark_complete" is handled together with "send" below. Double is no
  // longer part of the process, so completing a month always closes + sends
  // statements through SNAP — there is no "closed outside SNAP" no-send path.

  if (action === "spot_check") {
    // AI second-opinion on the statements. Requires the statements snapshot
    // (i.e. the bookkeeper opened the review). Advisory only.
    const { data: existing } = await (service as any)
      .from("monthly_rec_runs")
      .select("id, statements, kind, period")
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .maybeSingle();
    if (!existing?.statements) {
      return NextResponse.json(
        { error: "Load the statements first." },
        { status: 400 }
      );
    }
    const [y, m] = period.split("-").map(Number);
    const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const spot = await aiSpotCheckStatements({
      clientName: (client as any).client_name || "client",
      monthLabel,
      statements: existing.statements,
      kind: existing.kind === "cleanup" ? "cleanup" : "production_me",
    });
    const { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .update({ ai_spot_check: spot })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, run });
  }

  if (action === "submit") {
    // JR path: attest + submit for senior review. Surfaces on /today for
    // admin/lead, who approve & send. Same gate as send: checks +
    // statements + attestation.
    if (body.attested !== true) {
      return NextResponse.json(
        { error: "Attestation required — review the statements and tick the approval box first." },
        { status: 400 }
      );
    }
    const { data: existing } = await (service as any)
      .from("monthly_rec_runs")
      .select("id, checks_ran_at, statements, status")
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .maybeSingle();
    if (!existing?.checks_ran_at) {
      return NextResponse.json({ error: "Run the checks for this month first." }, { status: 400 });
    }
    if (!existing?.statements) {
      return NextResponse.json({ error: "Review the financial statements first." }, { status: 400 });
    }
    if (existing.status === "complete") {
      return NextResponse.json({ error: "This month is already closed." }, { status: 409 });
    }
    const concerns = (body.concerns || "").trim().slice(0, 4000) || null;
    const now = new Date().toISOString();
    const submitUpdate: any = {
      status: "pending_review",
      concerns,
      has_concerns: !!concerns,
      attested_by: user.id,
      attested_at: now,
      attest_scope: attestScope,
      submitted_by: user.id,
      submitted_at: now,
    };
    let { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .update(submitUpdate)
      .eq("id", existing.id)
      .select("*")
      .single();
    // attest_scope column not migrated yet → retry without it.
    if (error && /attest_scope/.test(error.message)) {
      delete submitUpdate.attest_scope;
      ({ data: run, error } = await (service as any)
        .from("monthly_rec_runs")
        .update(submitUpdate)
        .eq("id", existing.id)
        .select("*")
        .single());
    }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, run });
  }

  if (action === "send_draft") {
    // The bookkeeper's "not sure yet" path (Mike 2026-07-17): send the client
    // their numbers marked DRAFT plus a question — portal message + email.
    // The month STAYS OPEN: no close, no QBO closing date, no month-end
    // package, no statement archive. After the client answers, fix the books
    // (or approve the red flags) and do the real close.
    const question = (body.question || "").trim().slice(0, 2000);
    if (!question) {
      return NextResponse.json({ error: "Write the question you want to ask the client." }, { status: 400 });
    }
    const { data: draftRun } = await (service as any)
      .from("monthly_rec_runs")
      .select("*")
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .maybeSingle();
    if (draftRun?.status === "complete") {
      return NextResponse.json({ error: "This month is already closed — the final statements went out." }, { status: 409 });
    }
    if (!draftRun?.statements) {
      return NextResponse.json({ error: "Load the statements first — the draft includes this month's numbers." }, { status: 400 });
    }

    const clientName = (client as any).client_name || "your business";
    const [y, m] = period.split("-").map(Number);
    const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const glance = atAGlanceLines(draftRun.statements, monthLabel);
    const draftBody = [
      `Before we finalize your ${monthLabel} books, we have a quick question:`,
      ``,
      `❓ ${question}`,
      ``,
      `Your DRAFT ${monthLabel} numbers so far:`,
      ...glance.slice(1),
      ``,
      `These are draft figures — we'll finalize and send your official statements once we hear back. Just reply to this message.`,
    ].join("\n");
    const draftSubject = `DRAFT ${monthLabel} financials — quick question`;

    // Portal message (expects a reply) + branded email.
    let commError: string | null = null;
    try {
      await (service as any).from("client_communications").insert({
        client_link_id: clientLinkId,
        sender_user_id: user.id,
        direction: "to_client",
        kind: "message",
        subject: draftSubject,
        body: draftBody,
        attachments: [],
      });
    } catch (e: any) {
      commError = e?.message || "portal message insert failed";
    }
    const emailDelivery = await emailPortalUsersAboutMessage(service, {
      clientLinkId,
      clientName,
      kind: "message",
      subject: draftSubject,
      body: draftBody,
      portalOrigin: new URL(request.url).origin,
      snippetChars: 1200, // the question + numbers must survive into the email
    });

    // Record the draft on the run (migration 131) + audit trail. The send
    // already happened — a missing column degrades to a warning, not a 500.
    const draftEntry = {
      at: new Date().toISOString(),
      by: user.id,
      by_name: (actor as any)?.full_name || null,
      question,
      email_sent: !!(emailDelivery as any)?.sent,
    };
    let draftRecordError: string | null = null;
    let run: any = draftRun;
    {
      const prev = Array.isArray((draftRun as any).draft_sends) ? (draftRun as any).draft_sends : [];
      const { data: updated, error: uErr } = await (service as any)
        .from("monthly_rec_runs")
        .update({ draft_sends: [...prev, draftEntry] })
        .eq("id", draftRun.id)
        .select("*")
        .single();
      if (uErr) draftRecordError = `Draft sent, but couldn't record it on the month (migration 131 applied?): ${uErr.message}`;
      else run = updated;
    }
    try {
      await (service as any).from("audit_log").insert({
        event_type: "statements_draft_sent",
        user_id: user.id,
        request_payload: {
          client_link_id: clientLinkId,
          client_name: clientName,
          period,
          question,
          email_delivery: emailDelivery,
        },
      });
    } catch {
      /* best-effort */
    }

    return NextResponse.json({
      ok: true,
      run,
      email_delivery: emailDelivery,
      comm_error: commError,
      draft_record_error: draftRecordError,
    });
  }

  if (action === "send" || action === "mark_complete") {
    const isMarkComplete = action === "mark_complete";
    // Completing a month always closes + sends statements through SNAP now
    // (Double is retired). Sending client-facing statements is admin/lead only;
    // JRs submit for review instead.
    if (!isSenior) {
      return NextResponse.json(
        { error: "Only an admin or lead can close & send statements to the client — use Submit for review instead." },
        { status: 403 }
      );
    }
    // Every client-facing send requires an explicit attestation — the human
    // "I've reviewed these and they're ready" step. This covers BOTH the
    // review-screen send AND the board's Completed action. Previously
    // mark_complete was exempt (board Completed = implicit sign-off), which
    // let statements go out with no verification and mis-fired real emails.
    // The UI must collect this via a confirmation popup before either action.
    if (body.attested !== true) {
      return NextResponse.json(
        { error: "Attestation required — confirm you've reviewed the statements before they're sent to the client." },
        { status: 400 }
      );
    }
    let { data: existing } = await (service as any)
      .from("monthly_rec_runs")
      .select("id, checks_ran_at, statements, status, kind, attested_by, attested_at, verification, verification_score, verification_ran_at, manager_reviewed_by, manager_reviewed_at")
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .maybeSingle();
    if (existing?.status === "complete") {
      return NextResponse.json({ error: "This month is already closed." }, { status: 409 });
    }
    if (isMarkComplete) {
      // Completed straight from the board (no review screen opened) → always
      // (re)build the statements snapshot fresh, so the email summary has
      // current, complete numbers (incl. COGS / gross profit) rather than a
      // stale snapshot from a prior flow.
      {
        try {
          const accessToken = await getValidToken(clientLinkId, service as any);
          const statements = await fetchStatementsPreview(
            (client as any).qbo_realm_id,
            accessToken,
            periodStart,
            periodEnd,
            { includeBS, revenueMode: (client as any).revenue_recognition_mode }
          );
          const { data: up, error: upErr } = await (service as any)
            .from("monthly_rec_runs")
            .upsert(
              {
                client_link_id: clientLinkId,
                period,
                period_start: periodStart,
                period_end: periodEnd,
                kind: "production_me",
                statements,
                created_by: user.id,
              },
              { onConflict: "client_link_id,period" }
            )
            .select("id, checks_ran_at, statements, status, kind, attested_by, attested_at, verification, verification_score, verification_ran_at, manager_reviewed_by, manager_reviewed_at")
            .single();
          if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
          existing = up;
        } catch (err: any) {
          return qboErrorResponse(err);
        }
      }
    } else {
      // The gate: checks must have run AND statements must have been
      // fetched (i.e. reviewed) for this period before sending.
      if (!existing?.checks_ran_at) {
        return NextResponse.json(
          { error: "Run the checks for this month before closing it." },
          { status: 400 }
        );
      }
      if (!existing?.statements) {
        return NextResponse.json(
          { error: "Review the financial statements before sending." },
          { status: 400 }
        );
      }
    }

    // ── BOOKS RELIABILITY GATE ─────────────────────────────────────────
    // Soft-launch: the score always computes and displays; the send is only
    // blocked when VERIFICATION_GATE_ENFORCE=true. Below-threshold sends
    // require a senior's written override reason (recorded + audited).
    const gateOn = process.env.VERIFICATION_GATE_ENFORCE === "true";
    let overrideRecord: { by: string; at: string; reason: string; score_at_override: number } | null = null;
    if (gateOn) {
      if (!existing?.verification_ran_at) {
        return NextResponse.json(
          { error: "Run Verify books for this month before closing it.", requires_verification: true },
          { status: 400 }
        );
      }
      const vScore = Number(existing.verification_score ?? 0);
      if (vScore < SEND_MIN_SCORE) {
        const overrideReason = (body.override_reason || "").trim();
        if (!overrideReason) {
          return NextResponse.json(
            {
              error: `Books Reliability score is ${vScore} — below ${SEND_MIN_SCORE}. Fix the findings and re-verify, or override with a reason.`,
              verification_score: vScore,
              requires_override: true,
            },
            { status: 409 }
          );
        }
        overrideRecord = {
          by: user.id,
          at: new Date().toISOString(),
          reason: overrideReason.slice(0, 1000),
          score_at_override: vScore,
        };
      }
    }

    // ── TEMPORARY MANAGER-REVIEW GATE — see MANAGER_REVIEW_EMAIL above ──
    // Production closes only; cleanup sign-off (new-client, one-time) shares
    // this handler but is a different queue and stays ungated.
    let managerReviewStamp: { by: string; at: string } | null = null;
    let managerOverrideRecord: { by: string; at: string; reason: string } | null = null;
    if (MANAGER_REVIEW_EMAIL && existing?.kind !== "cleanup") {
      const { data: reviewer } = await service
        .from("users")
        .select("id")
        .ilike("email", MANAGER_REVIEW_EMAIL)
        .eq("is_active", true)
        .maybeSingle();
      if (!reviewer) {
        console.warn(
          `[monthly-rec] manager-review gate: no active user for "${MANAGER_REVIEW_EMAIL}" — gate skipped this send`
        );
      } else if (user.id === (reviewer as any).id) {
        // She's the one sending — that IS the review.
        managerReviewStamp = { by: user.id, at: new Date().toISOString() };
      } else if (!existing?.manager_reviewed_at) {
        const reason = (body.manager_override_reason || "").trim();
        if (!reason) {
          return NextResponse.json(
            {
              error:
                "Awaiting Kedma's review before this can be sent this month. She can review & send it herself, or you can override with a reason.",
              requires_manager_review: true,
            },
            { status: 409 }
          );
        }
        managerOverrideRecord = {
          by: user.id,
          at: new Date().toISOString(),
          reason: reason.slice(0, 1000),
        };
      }
    }

    // ── RED-FLAG APPROVAL GATE (Mike 2026-07-17) — ALWAYS ON ────────────
    // Duplicate expenses, duplicate revenue, COGS outside 20–65%, net margin
    // outside 10–35%: each open red flag must be FIXED (re-verify clears it)
    // or explicitly APPROVED (dismissed with a reason — recorded who/why)
    // before anything goes to the client. Unlike the score gate above, this
    // does not wait for VERIFICATION_GATE_ENFORCE.
    {
      let verification = (existing as any)?.verification as VerificationResult | null;
      if (!verification) {
        // Board completes / backfills arrive unverified — run it now so the
        // gate always judges real findings (and the card gets a score).
        try {
          const accessToken = await getValidToken(clientLinkId, service as any);
          verification = await runBooksVerification({
            service: service as any,
            clientLinkId,
            realmId: (client as any).qbo_realm_id,
            accessToken,
            period,
            periodStart,
            periodEnd,
            includeBS,
            kind: ((existing as any)?.kind as any) || "production_me",
            ranBy: user.id,
          });
          const { data: vUp } = await (service as any)
            .from("monthly_rec_runs")
            .update({
              verification,
              verification_score: verification.score,
              verification_ran_at: verification.ranAt,
            })
            .eq("id", (existing as any).id)
            .select("id, checks_ran_at, statements, status, kind, attested_by, attested_at, verification, verification_score, verification_ran_at, manager_reviewed_by, manager_reviewed_at")
            .single();
          if (vUp) existing = vUp;
        } catch (err: any) {
          return NextResponse.json(
            {
              error: `Books can't go out unverified — and verification failed to run: ${String(err?.message || err).slice(0, 300)}. Fix the QBO connection (or run Verify books on the month card) and try again.`,
            },
            { status: 502 }
          );
        }
      }
      // Judge against the CURRENT dismissal set so an approval made a moment
      // ago counts without a full re-verify.
      const { data: dRows } = await (service as any)
        .from("verification_dismissals")
        .select("check_key, fingerprint, reason, dismissed_at, active")
        .eq("client_link_id", clientLinkId)
        .eq("active", true);
      const gateDismissals: DismissalRow[] = ((dRows as any[]) || []).map((d) => ({
        ...d,
        dismissed_by_name: null,
      }));
      const recomputed = recomputeStoredVerification(verification!, gateDismissals, includeBS);
      const redFlags = openRedFlags(recomputed);
      if (redFlags.length > 0) {
        return NextResponse.json(
          {
            error: `${redFlags.length} red flag${redFlags.length === 1 ? "" : "s"} need${redFlags.length === 1 ? "s" : ""} manual approval before this month goes to the client — fix and re-verify, or approve each with a reason.`,
            requires_red_flag_approval: true,
            red_flags: redFlags,
          },
          { status: 409 }
        );
      }
    }

    const concerns = (body.concerns || "").trim().slice(0, 4000) || null;
    const now = new Date().toISOString();
    const clientName = (client as any).client_name || "your business";
    const [y, m] = period.split("-").map(Number);
    const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    const st = existing.statements as any;
    const lines = atAGlanceLines(st, monthLabel);
    const summaryBody = [
      `Your ${monthLabel} books are closed and your financial statements are ready. ✅`,
      ``,
      ...lines,
      ``,
      `See the full Profit & Loss and Balance Sheet in your portal.`,
    ].join("\n");

    // 1. Portal notification — amber Bell card in their Messages, red
    //    badge + chime on their nav, visible in the snap thread too.
    let commError: string | null = null;
    try {
      await (service as any).from("client_communications").insert({
        client_link_id: clientLinkId,
        sender_user_id: user.id,
        direction: "to_client",
        kind: "notification",
        subject: `Your ${monthLabel} financials are ready`,
        body: summaryBody,
        attachments: [],
      });
    } catch (e: any) {
      commError = e?.message || "notification insert failed";
    }

    // 2. FULL CLOSE — month-end package (AI summary + archived statements
    //    published to the portal + statements email). The manager's
    //    approval IS the summary review, so gates are bypassed (force).
    //    Best-effort: a package failure falls back to the plain
    //    notification email so the client always hears about the close.
    const origin = new URL(request.url).origin;
    const periodRef = { periodYear: y, periodMonth: m };
    let packageId: string | null = null;
    let packageError: string | null = null;
    let emailDelivery: any = null;
    try {
      if (!includeBS) {
        // P&L-only client: the month-end package archives a BS snapshot,
        // so skip it and use the plain statements email below.
        throw new Error("P&L-only close (Balance Sheet toggle off) — plain email sent");
      }
      const built = await buildPackagesBulk(service as any, [clientLinkId], periodRef, user.id);
      if (!built[0]?.ok || !built[0].packageId) {
        throw new Error(built[0]?.error || "package build failed");
      }
      packageId = built[0].packageId;
      const gen = await generateSummariesBatch(service as any, [packageId]);
      if (gen.failed > 0) throw new Error(gen.errors.join("; ") || "summary failed");
      await bulkApproveSummaries(service as any, [packageId], user.id);
      const delivered = await deliverPackagesBulk(service as any, [packageId], user.id, origin, {
        force: true,
      });
      if (delivered.failed > 0) {
        throw new Error(delivered.results[0]?.error || "delivery failed");
      }
      emailDelivery = { sent: true, recipients: 1, via: "month_end_package" };
    } catch (e: any) {
      packageError = String(e?.message || e).slice(0, 500);
      // Fallback: plain notification email so the close still reaches them
      emailDelivery = await emailPortalUsersAboutMessage(service, {
        clientLinkId,
        clientName,
        kind: "notification",
        subject: `Your ${monthLabel} financials are ready`,
        body: summaryBody,
        portalOrigin: origin,
      });
    }

    // 2b. Close the books in QuickBooks — set the company closing date to
    //     the period end. Best-effort: failure is recorded and surfaced,
    //     never blocks the close.
    let qboCloseError: string | null = null;
    try {
      const accessToken = await getValidToken(clientLinkId, service as any);
      await updateClosingDate((client as any).qbo_realm_id, accessToken, periodEnd);
    } catch (e: any) {
      qboCloseError = String(e?.message || e).slice(0, 500);
    }

    // 3. Close the period. Preserve the JR's attestation when this is a
    //    senior approving a submitted run; the senior's approval is the
    //    completed_by trail.
    const completeUpdate: any = {
      status: "complete",
      concerns,
      has_concerns: !!concerns,
      attested_by: existing.attested_by || user.id,
      attested_at: existing.attested_at || now,
      attest_scope: (existing as any).attest_scope || attestScope,
      completed_by: user.id,
      completed_at: now,
      sent_to_client_at: now,
      email_delivery: emailDelivery,
      month_end_package_id: packageId,
      qbo_close_error: qboCloseError,
      ...(overrideRecord ? { verification_override: overrideRecord } : {}),
      ...(managerReviewStamp
        ? { manager_reviewed_by: managerReviewStamp.by, manager_reviewed_at: managerReviewStamp.at }
        : {}),
      ...(managerOverrideRecord ? { manager_review_override: managerOverrideRecord } : {}),
    };
    let { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .update(completeUpdate)
      .eq("id", existing.id)
      .select("*")
      .single();
    // attest_scope column not migrated yet → retry without it.
    if (error && /attest_scope/.test(error.message)) {
      delete completeUpdate.attest_scope;
      ({ data: run, error } = await (service as any)
        .from("monthly_rec_runs")
        .update(completeUpdate)
        .eq("id", existing.id)
        .select("*")
        .single());
    }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // A below-threshold send is a real event — audit it so the Approvals
    // overrides widget and any later review can see who/why.
    if (overrideRecord) {
      try {
        await (service as any).from("audit_log").insert({
          event_type: "verification_override",
          request_payload: {
            client_link_id: clientLinkId,
            client_name: clientName,
            period,
            score: overrideRecord.score_at_override,
            reason: overrideRecord.reason,
            overridden_by: user.id,
          },
        });
      } catch {
        /* best-effort */
      }
    }
    if (managerOverrideRecord) {
      try {
        await (service as any).from("audit_log").insert({
          event_type: "manager_review_override",
          request_payload: {
            client_link_id: clientLinkId,
            client_name: clientName,
            period,
            reason: managerOverrideRecord.reason,
            overridden_by: user.id,
          },
        });
      } catch {
        /* best-effort */
      }
    }

    // Cleanup sign-off: approving + sending the statements IS the cleanup
    // completion — stamp the client record and GRADUATE them to
    // Production (daily recon on, joins the /production board).
    if (existing.kind === "cleanup") {
      await service
        .from("client_links")
        .update({
          cleanup_completed_at: now,
          cleanup_completed_by: user.id,
        } as any)
        .eq("id", clientLinkId)
        .is("cleanup_completed_at", null);
      await service
        .from("client_links")
        .update({ daily_recon_enabled: true, daily_recon_paused: false } as any)
        .eq("id", clientLinkId);
    }

    return NextResponse.json({
      ok: true,
      run,
      email_delivery: emailDelivery,
      comm_error: commError,
      month_end_package_id: packageId,
      package_error: packageError,
      qbo_close_error: qboCloseError,
    });
  }

  // reject — senior Manager Reject on a production close in review. Bounces the
  // run to 'failed_review' with a required note; the assigned bookkeeper sees it
  // on Today ("Sent back — needs rework") and reworks, then re-submits. No
  // client email.
  if (action === "reject") {
    if (!isSenior) {
      return NextResponse.json(
        { error: "Only admin/lead can reject a close." },
        { status: 403 }
      );
    }
    const rejectNote = (body.notes || "").toString().trim();
    if (!rejectNote) {
      return NextResponse.json(
        { error: "Add a note telling the bookkeeper what to fix before rejecting." },
        { status: 400 }
      );
    }
    const nowIso = new Date().toISOString();
    const { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .update({
        status: "failed_review",
        review_notes: rejectNote,
        rejected_at: nowIso,
        rejected_by: user.id,
      })
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "monthly_rec_review_rejected",
      request_payload: { client_link_id: clientLinkId, period, notes: rejectNote, rejected_at: nowIso } as any,
    });
    return NextResponse.json({ ok: true, run });
  }

  // reopen
  const { data: run, error } = await (service as any)
    .from("monthly_rec_runs")
    .update({
      status: "open",
      completed_by: null,
      completed_at: null,
      attested_by: null,
      attested_at: null,
      submitted_by: null,
      submitted_at: null,
      sent_to_client_at: null,
    })
    .eq("client_link_id", clientLinkId)
    .eq("period", period)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, run });
}

/**
 * "Month at a glance" bullet lines from a statements snapshot. Builds a
 * breakdown that always reconciles to net: Revenue − COGS = Gross profit,
 * then − Operating expenses; any remainder (other income/expense) becomes an
 * explicit line so the figures the client sees add up. Shared by the close
 * email and DRAFT sends.
 */
function atAGlanceLines(st: any, monthLabel: string): string[] {
  const fmt = (n: number) =>
    `$${Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Signed format for the "other income/(expense)" reconciling line.
  const fmtSigned = (n: number) => (n < 0 ? `-${fmt(n)}` : fmt(n));
  const revenue = Number(st?.pl?.totalIncome || 0);
  const cogs = Number(st?.pl?.cogs || 0);
  const opex = Number(st?.pl?.totalExpenses || 0);
  const net = Number(st?.pl?.netIncome || 0);
  const hasCogs = cogs > 0.005;
  const grossProfit = Number(
    st?.pl?.grossProfit != null ? st.pl.grossProfit : revenue - cogs
  );
  const lines: string[] = [`${monthLabel} at a glance:`, `• Revenue: ${fmt(revenue)}`];
  if (hasCogs) {
    lines.push(`• Cost of goods sold: ${fmt(cogs)}`);
    lines.push(`• Gross profit: ${fmt(grossProfit)}`);
  }
  lines.push(`• Operating expenses: ${fmt(opex)}`);
  const subtotal = (hasCogs ? grossProfit : revenue) - opex;
  const other = net - subtotal;
  if (Math.abs(other) > 0.5) {
    lines.push(`• Other income/(expense): ${fmtSigned(other)}`);
  }
  lines.push(`• Net ${net >= 0 ? "profit" : "loss"}: ${fmt(net)}`);
  return lines;
}
