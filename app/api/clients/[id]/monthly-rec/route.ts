import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import { previousMonthPeriod, runMonthlyRecChecks } from "@/lib/monthly-rec";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/clients/[id]/monthly-rec
 *
 * Body:
 *   { action: "run",      period?: "YYYY-MM" }
 *       → run the read-only QBO checks for the month, upsert the run row
 *         (status stays/open) and return the checks.
 *   { action: "complete", period?: "YYYY-MM", concerns?: string }
 *       → mark the month complete, persisting any concern notes.
 *   { action: "reopen",   period?: "YYYY-MM" }
 *       → flip a completed month back to open (mistake / new info).
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

  let body: { action?: string; period?: string; concerns?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body.action;
  if (!["run", "complete", "reopen"].includes(action || "")) {
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

  if (action === "complete") {
    const concerns = (body.concerns || "").trim().slice(0, 4000) || null;
    const { data: run, error } = await (service as any)
      .from("monthly_rec_runs")
      .upsert(
        {
          client_link_id: clientLinkId,
          period,
          period_start: periodStart,
          period_end: periodEnd,
          status: "complete",
          concerns,
          has_concerns: !!concerns,
          completed_by: user.id,
          completed_at: new Date().toISOString(),
        },
        { onConflict: "client_link_id,period" }
      )
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, run });
  }

  // reopen
  const { data: run, error } = await (service as any)
    .from("monthly_rec_runs")
    .update({ status: "open", completed_by: null, completed_at: null })
    .eq("client_link_id", clientLinkId)
    .eq("period", period)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, run });
}
