import { createServiceSupabase } from "@/lib/supabase";
import { runDunning } from "@/lib/billing-dunning";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/billing-dunning  (Vercel Cron, daily)
 * Sends past-due reminders on cadence and (if DUNNING_AUTOSUSPEND='true') holds
 * portal access after the grace period. Auth: Authorization: Bearer CRON_SECRET.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const service = createServiceSupabase();
  const origin = new URL(request.url).origin;
  try {
    const result = await runDunning(service, { origin, actorId: null });
    await service.from("audit_log").insert({ event_type: "billing_dunning_cron", request_payload: result as any });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Dunning failed" }, { status: 500 });
  }
}
