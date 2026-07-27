import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { buildPackagesBulk } from "@/lib/month-end/package-builder";
import { generateSummariesBatch } from "@/lib/month-end/generate-summaries";
import { bulkApproveSummaries } from "@/lib/month-end/bulk-approve";
import { deliverPackagesBulk } from "@/lib/month-end/send";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Backfill the full month-end PORTAL PACKAGE for months that were closed but
 * only ever delivered as a plain summary email (P&L-only clients + any close
 * where the package pipeline fell back — see monthly-rec "send"). Publishes the
 * P&L (and BS if the client has one) to the client's portal and sends the
 * branded "your statements are ready" email.
 *
 *   POST { period: "YYYY-MM", dry_run?: true, client_ids?: string[] }
 *
 * dry_run (default TRUE) returns the candidate list and writes/sends nothing.
 * Candidates = a completed monthly_rec_run for the period with NO delivered
 * month_end_package. Runs the real package pipeline (skipGateCheck: the month
 * was already reviewed & closed; force delivery like the close path does).
 * Admin/lead only.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const period = String(body.period || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "period 'YYYY-MM' required" }, { status: 400 });
  }
  const dryRun = body.dry_run !== false;
  const [py, pm] = period.split("-").map(Number);
  const periodRef = { periodYear: py, periodMonth: pm };
  const only: string[] | null = Array.isArray(body.client_ids) && body.client_ids.length
    ? body.client_ids.map(String)
    : null;

  // Completed closes for the period.
  const { data: runs } = await (service as any)
    .from("monthly_rec_runs")
    .select("client_link_id, sent_to_client_at, email_delivery, month_end_package_id")
    .eq("period", period)
    .eq("status", "complete");
  const completedIds: string[] = ((runs as any[]) || []).map((r) => r.client_link_id);

  // Packages already delivered for the period (so we skip full closes).
  const { data: pkgs } = completedIds.length
    ? await (service as any)
        .from("month_end_packages")
        .select("client_link_id, email_sent_at, portal_published_at")
        .eq("period_year", py)
        .eq("period_month", pm)
        .in("client_link_id", completedIds)
    : { data: [] };
  const deliveredPkgClient = new Set(
    ((pkgs as any[]) || [])
      .filter((p) => p.email_sent_at || p.portal_published_at)
      .map((p) => p.client_link_id)
  );

  // Candidates: completed, no delivered package (email-only / closed-not-sent).
  let candidateIds = completedIds.filter((id) => !deliveredPkgClient.has(id));
  if (only) candidateIds = candidateIds.filter((id) => only.includes(id));
  candidateIds = [...new Set(candidateIds)];

  const { data: clientRows } = candidateIds.length
    ? await service.from("client_links").select("id, client_name, bs_enabled").in("id", candidateIds)
    : { data: [] };
  const byId = new Map(((clientRows as any[]) || []).map((c) => [c.id, c]));
  const candidates = candidateIds.map((id) => ({
    client_link_id: id,
    client_name: (byId.get(id) as any)?.client_name || "(unknown)",
    pl_only: (byId.get(id) as any)?.bs_enabled === false,
  }));
  candidates.sort((a, b) => a.client_name.localeCompare(b.client_name));

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      period,
      candidate_count: candidates.length,
      candidates,
      note: "Nothing published or emailed. Re-send with dry_run:false (optionally client_ids) to publish + email these.",
    });
  }

  // ── EXECUTE — publish the package + email, one client at a time ──
  const origin = new URL(request.url).origin;
  const results: Array<{ client_link_id: string; client_name: string; ok: boolean; error?: string; package_id?: string }> = [];
  for (const c of candidates) {
    const id = c.client_link_id;
    try {
      const built = await buildPackagesBulk(service as any, [id], periodRef, user.id, { skipGateCheck: true });
      if (!built[0]?.ok || !built[0].packageId) throw new Error(built[0]?.error || "package build failed");
      const packageId = built[0].packageId;
      const gen = await generateSummariesBatch(service as any, [packageId]);
      if (gen.failed > 0) throw new Error(gen.errors.join("; ") || "summary generation failed");
      await bulkApproveSummaries(service as any, [packageId], user.id);
      const delivered = await deliverPackagesBulk(service as any, [packageId], user.id, origin, { force: true });
      if (delivered.failed > 0) throw new Error(delivered.results?.[0]?.error || "delivery failed");
      results.push({ client_link_id: id, client_name: c.client_name, ok: true, package_id: packageId });
    } catch (e: any) {
      results.push({ client_link_id: id, client_name: c.client_name, ok: false, error: String(e?.message || e).slice(0, 400) });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  try {
    await (service as any).from("audit_log").insert({
      event_type: "portal_package_backfilled",
      user_id: user.id,
      request_payload: { period, attempted: results.length, sent, failed: results.length - sent } as any,
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ dry_run: false, period, attempted: results.length, sent, failed: results.length - sent, results });
}
