import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { scanClientForDuplicates } from "@/lib/dup-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/dup-sweep — the one-time clean sweep + weekly cron target.
 *
 * Scans every active client with a completed cleanup OR on daily recon
 * (i.e., books we've already made accurate and must keep accurate).
 * Read-only against QBO; findings land in dup_findings and surface on the
 * /today Duplicates queue + reclass Duplicates stage. Runs in the
 * background; one audit_log row records the totals.
 *
 * Auth: admin session OR Vercel cron (Authorization: Bearer CRON_SECRET).
 */
export async function POST(request: Request) {
  const service = createServiceSupabase();

  const cronOk =
    !!process.env.CRON_SECRET &&
    request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  let userId: string | null = null;
  if (!cronOk) {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
    if ((actor as any)?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
    }
    userId = user.id;
  }

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, cleanup_completed_at, daily_recon_enabled")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null);
  const targets = ((clients as any[]) || []).filter(
    (c) =>
      (c.cleanup_completed_at || c.daily_recon_enabled) &&
      c.qbo_realm_id !== "DEMO" &&
      !/\btest\b/i.test(c.client_name || "")
  );

  after(async () => {
    const svc = createServiceSupabase();
    const totals = { clients: 0, failed: 0, found: 0, certain: 0, likely: 0 };
    for (const c of targets) {
      try {
        const r = await scanClientForDuplicates(svc, c);
        totals.clients++;
        totals.found += r.found;
        totals.certain += r.certain;
        totals.likely += r.likely;
      } catch (e: any) {
        totals.failed++;
        console.error(`[dup-sweep] ${c.client_name}: ${e?.message}`);
      }
      await new Promise((res) => setTimeout(res, 400)); // pace QBO API
    }
    try {
      await svc.from("audit_log").insert({
        event_type: "dup_sweep_completed",
        user_id: userId,
        request_payload: totals as any,
      });
    } catch {}
  });

  return NextResponse.json({ started: true, targets: targets.length });
}

/** Vercel crons call GET. */
export async function GET(request: Request) {
  return POST(request);
}
