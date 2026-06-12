import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import {
  aiSpotCheckStatements,
  fetchStatementsPreview,
  previousMonthPeriod,
  runMonthlyRecChecks,
} from "@/lib/monthly-rec";
import { emailPortalUsersAboutMessage } from "@/lib/client-comms";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
    .select("id, client_name, qbo_realm_id, assigned_bookkeeper_id, daily_recon_enabled")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
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
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body.action;
  if (!["run", "statements", "spot_check", "submit", "send", "reopen"].includes(action || "")) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

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
      const result = await runMonthlyRecChecks(
        (client as any).qbo_realm_id,
        accessToken,
        periodStart,
        periodEnd
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

  if (action === "statements") {
    try {
      const accessToken = await getValidToken(clientLinkId, service as any);
      const statements = await fetchStatementsPreview(
        (client as any).qbo_realm_id,
        accessToken,
        periodStart,
        periodEnd
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
    const { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .update({
        status: "pending_review",
        concerns,
        has_concerns: !!concerns,
        attested_by: user.id,
        attested_at: now,
        submitted_by: user.id,
        submitted_at: now,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, run });
  }

  if (action === "send") {
    // FINAL approval — admin/lead only. JRs submit for review instead.
    if (!isSenior) {
      return NextResponse.json(
        { error: "Only an admin or lead can send statements to the client — use Submit for review instead." },
        { status: 403 }
      );
    }
    if (body.attested !== true) {
      return NextResponse.json(
        { error: "Attestation required — review the statements and tick the approval box first." },
        { status: 400 }
      );
    }
    // The gate: checks must have run AND statements must have been
    // fetched (i.e. reviewed) for this period before sending.
    const { data: existing } = await (service as any)
      .from("monthly_rec_runs")
      .select("id, checks_ran_at, statements, status, kind, attested_by, attested_at")
      .eq("client_link_id", clientLinkId)
      .eq("period", period)
      .maybeSingle();
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
    if (existing.status === "complete") {
      return NextResponse.json({ error: "This month is already closed." }, { status: 409 });
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
    const fmt = (n: number) =>
      `$${Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const net = Number(st?.pl?.netIncome || 0);
    const summaryBody = [
      `Your ${monthLabel} books are closed and your financial statements are ready. ✅`,
      ``,
      `${monthLabel} at a glance:`,
      `• Income: ${fmt(st?.pl?.totalIncome || 0)}`,
      `• Expenses: ${fmt(st?.pl?.totalExpenses || 0)}`,
      `• Net ${net >= 0 ? "profit" : "loss"}: ${fmt(net)}`,
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

    // 2. Email the client's portal users
    const emailDelivery = await emailPortalUsersAboutMessage(service, {
      clientLinkId,
      clientName,
      kind: "notification",
      subject: `Your ${monthLabel} financials are ready`,
      body: summaryBody,
      portalOrigin: new URL(request.url).origin,
    });

    // 3. Close the period. Preserve the JR's attestation when this is a
    //    senior approving a submitted run; the senior's approval is the
    //    completed_by trail.
    const { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .update({
        status: "complete",
        concerns,
        has_concerns: !!concerns,
        attested_by: existing.attested_by || user.id,
        attested_at: existing.attested_at || now,
        completed_by: user.id,
        completed_at: now,
        sent_to_client_at: now,
        email_delivery: emailDelivery,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Cleanup sign-off: approving + sending the statements IS the cleanup
    // completion — stamp the client record if it isn't already.
    if (existing.kind === "cleanup") {
      await service
        .from("client_links")
        .update({
          cleanup_completed_at: now,
          cleanup_completed_by: user.id,
        } as any)
        .eq("id", clientLinkId)
        .is("cleanup_completed_at", null);
    }

    return NextResponse.json({
      ok: true,
      run,
      email_delivery: emailDelivery,
      comm_error: commError,
    });
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
