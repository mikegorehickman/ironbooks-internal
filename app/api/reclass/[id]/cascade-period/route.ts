import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { getCompanyClosingDate } from "@/lib/qbo-reclass";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/reclass/[id]/cascade-period
 *
 * Walk BACKWARDS one period at a time from a finished job, instead of
 * brute-forcing a whole year up front.
 *
 * Why this shape (Mike, 2026-08-04): the first period is the expensive one —
 * every transaction gets an AI classification and the bookkeeper makes ~40
 * vendor decisions. Those decisions are written as bank rules, and discovery's
 * pre-pass consults that cache BEFORE calling Claude. So each period after the
 * first is mostly cache hits: cheap, fast, and only genuinely-new vendors reach
 * the queue. Running the year first inverts that — full AI cost on 1600+ rows
 * and 380 decisions in one fatigued sitting, with no rules to lean on.
 *
 * CLOSED PERIODS: a cascade that reaches a month already delivered to the
 * client would rewrite filed books. Rather than post silently, we stop and
 * report — the caller gets `blocked_by_closed_period` with the closing date,
 * and can re-issue with `acknowledge_closed: true` to scope the window to the
 * open portion only. We never widen a window past the close.
 *
 * Body: { months?: number (default 1), acknowledge_closed?: boolean }
 */
const MAX_CHAIN = 12; // a year of monthly hops

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: sourceJobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const body = await request.json().catch(() => ({} as any));
  const months = Math.max(1, Math.min(12, Number(body.months) || 1));

  const { data: sourceJob } = await service
    .from("reclass_jobs")
    .select("*")
    .eq("id", sourceJobId)
    .single();
  if (!sourceJob) return NextResponse.json({ error: "Source job not found" }, { status: 404 });

  // Chain depth — monthly hops mean a longer legitimate chain than the old
  // yearly cascade, but still bounded.
  let chainLength = 1;
  let parent: string | null = (sourceJob as any).parent_job_id || null;
  while (parent && chainLength < MAX_CHAIN + 2) {
    const { data: p } = await service
      .from("reclass_jobs").select("parent_job_id").eq("id", parent).single();
    if (!p) break;
    chainLength++;
    parent = (p as any).parent_job_id || null;
  }
  if (chainLength >= MAX_CHAIN) {
    return NextResponse.json(
      { error: `Already cascaded ${chainLength} periods back — stop here.`, chain_length: chainLength },
      { status: 400 }
    );
  }

  // Window: the `months` calendar months immediately before the source job.
  const srcStart = new Date(`${String(sourceJob.date_range_start).slice(0, 10)}T00:00:00Z`);
  if (isNaN(srcStart.getTime())) {
    return NextResponse.json({ error: "Source job has no usable date range" }, { status: 400 });
  }
  const priorEnd = new Date(srcStart);
  priorEnd.setUTCDate(priorEnd.getUTCDate() - 1); // day before source start
  const priorStart = new Date(priorEnd);
  priorStart.setUTCDate(1);
  priorStart.setUTCMonth(priorStart.getUTCMonth() - (months - 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // ── Closed-period gate ──
  let closingDate: string | null = null;
  try {
    const { data: cl } = await (service as any)
      .from("client_links").select("qbo_realm_id").eq("id", sourceJob.client_link_id).maybeSingle();
    if ((cl as any)?.qbo_realm_id) {
      const token = await getValidToken(sourceJob.client_link_id, service as any);
      closingDate = await getCompanyClosingDate((cl as any).qbo_realm_id, token);
    }
  } catch {
    closingDate = null; // can't tell → treat as open, the executor still guards per-txn
  }

  let start = fmt(priorStart);
  const end = fmt(priorEnd);

  if (closingDate && start <= closingDate) {
    if (!body.acknowledge_closed) {
      // REPORT, don't post. The whole window may be closed, or only part.
      const fullyClosed = end <= closingDate;
      return NextResponse.json(
        {
          blocked_by_closed_period: true,
          closing_date: closingDate,
          requested: { start, end },
          fully_closed: fullyClosed,
          open_portion: fullyClosed ? null : { start: nextDay(closingDate), end },
          message: fullyClosed
            ? `${start} → ${end} sits entirely inside the closed period (books closed through ${closingDate}). Nothing to cascade — reopen the period in QuickBooks if these months genuinely need re-categorizing.`
            : `${start} → ${end} overlaps the closed period (books closed through ${closingDate}). Re-run with acknowledge_closed to cascade only ${nextDay(closingDate)} → ${end}.`,
        },
        { status: 409 }
      );
    }
    // Acknowledged: NARROW to the open portion. Never widen past the close.
    if (end <= closingDate) {
      return NextResponse.json(
        { error: `Entire window is closed through ${closingDate} — nothing to cascade.` },
        { status: 400 }
      );
    }
    start = nextDay(closingDate);
  }

  // Reuse discovery so job creation + kickoff stay in one place. The pre-pass
  // will hit the bank rules written by the source job's decisions, so most of
  // this window should resolve without an AI call.
  const url = new URL(request.url);
  const discoverRes = await fetch(`${url.protocol}//${url.host}/api/reclass/discover`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: request.headers.get("cookie") || "",
    },
    body: JSON.stringify({
      client_link_id: sourceJob.client_link_id,
      workflow: "full_categorization",
      date_range_start: start,
      date_range_end: end,
      jurisdiction: sourceJob.jurisdiction,
      state_province: sourceJob.state_province,
      auto_approve_threshold: (sourceJob as any).auto_approve_threshold,
    }),
  });
  const data = await discoverRes.json();
  if (!discoverRes.ok) {
    return NextResponse.json(
      { error: data?.error || "Failed to spawn cascade job" },
      { status: discoverRes.status }
    );
  }

  if (data.job_id) {
    await service
      .from("reclass_jobs")
      .update({ parent_job_id: sourceJobId } as any)
      .eq("id", data.job_id);
  }

  return NextResponse.json({
    ok: true,
    job_id: data.job_id,
    window: { start, end },
    months,
    chain_length: chainLength + 1,
    narrowed_for_closed_period: !!(closingDate && start === nextDay(closingDate)),
  });
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
