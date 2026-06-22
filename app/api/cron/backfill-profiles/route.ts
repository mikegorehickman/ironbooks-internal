import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { backfillProfilesFromGhl } from "@/lib/profile-backfill";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // ~76 clients × (GHL lookup + 150ms throttle)

/**
 * Nightly GHL → client-profile backfill.
 *
 * Fills BLANK profile fields (name, phone, legal business name, address,
 * country) for every active client from their GHL contact, matched by
 * client_email. Blanks-only — never overwrites bookkeeper-entered values — so
 * it's safe to run every night: it only ever fills gaps as clients update
 * their info in GHL or get their email corrected in SNAP.
 *
 * Auth (mirrors /api/cron/daily-recon):
 *   - Vercel Cron: `Authorization: Bearer ${CRON_SECRET}`
 *   - or a signed-in admin/lead (manual trigger)
 */
async function handleRequest(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  const service = createServiceSupabase();

  if (!isCron) {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
    if (!["admin", "lead"].includes((actor as any)?.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const result = await backfillProfilesFromGhl(service, { apply: true });
    await service.from("audit_log").insert({
      event_type: "ghl_profile_backfill_cron",
      request_payload: {
        total: result.total,
        clients_updated: result.touched,
        fields_filled: result.fieldsFilled,
        no_match_count: result.noMatch.length,
        triggered_by: isCron ? "cron" : "manual",
      } as any,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error("[cron/backfill-profiles] failed:", e?.message);
    return NextResponse.json({ ok: false, error: e?.message || "backfill failed" }, { status: 500 });
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
