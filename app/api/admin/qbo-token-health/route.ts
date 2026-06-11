import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { refreshAccessToken } from "@/lib/qbo";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/admin/qbo-token-health?limit=200&dry_run=true&skip_recent=24
 *
 * Probes every client_links row that has a qbo_refresh_token by calling
 * Intuit's refresh endpoint with `grant_type=refresh_token`. Reports per
 * client whether the token still works. The refreshed access_token AND the
 * rotated refresh_token are always persisted on success (Intuit rotates the
 * refresh token on every call — losing it kills the chain).
 *
 * `dry_run=true` does NOT probe at all: it lists candidates from stored
 * state without touching Intuit. (The old behavior — probe but skip the
 * persist — silently destroyed every probed chain, because the rotation
 * still happened server-side and the new token was thrown away.)
 *
 * Why this exists: PictureThis + Neighborhood Painting both failed
 * cleanups mid-stream with user_not_in_realm. Looking at the broader
 * cluster, ~20 clients hadn't refreshed in 13-17 days (the same window
 * around mid-May when the two confirmed failures occurred). Without a
 * proactive probe, we don't know which other clients have silently dead
 * tokens — bookkeepers find out by trying to run a cleanup, hitting the
 * error, and reporting it.
 *
 * Query params:
 *   - limit=N           cap how many clients to probe (default 50)
 *   - dry_run=true      list candidates only — no Intuit calls, no writes
 *   - skip_recent=24    skip clients whose access token was refreshed within
 *                       the last N hours (they're known-healthy). Default 24.
 *
 * Auth: admin or lead only. Service-role DB writes for the access_token
 * update when not dry_run.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!["admin", "lead"].includes(role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const skipRecentHours = parseInt(url.searchParams.get("skip_recent") || "24", 10);
  const skipBefore = new Date(Date.now() + skipRecentHours * 60 * 60 * 1000).toISOString();

  // Pull candidates: clients with a refresh token, ordered by oldest
  // access-token-expiry first (most likely to be broken). Optionally skip
  // clients refreshed within the last `skipRecent` hours.
  const { data: candidates } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, qbo_refresh_token, qbo_token_expires_at")
    .not("qbo_refresh_token", "is", null)
    .lt("qbo_token_expires_at", skipBefore)
    .order("qbo_token_expires_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  const rows = (candidates || []) as any[];

  const results: Array<{
    client_link_id: string;
    client_name: string;
    realm_id: string;
    expired_for_days: number;
    status: "healthy" | "dead" | "skipped";
    error?: string;
    error_code?: string;
  }> = [];

  for (const row of rows) {
    const expiredForDays =
      row.qbo_token_expires_at
        ? Math.max(
            0,
            Math.floor(
              (Date.now() - new Date(row.qbo_token_expires_at).getTime()) /
                (1000 * 60 * 60 * 24)
            )
          )
        : 0;

    // dry_run: DO NOT call Intuit. A refresh "probe" ROTATES the refresh
    // token server-side at Intuit; skipping the persist (old behavior) threw
    // the rotated token away and permanently killed the chain for every
    // client probed. There is no read-only refresh in OAuth — so a dry run
    // reports stored state only and never touches the network.
    if (dryRun) {
      results.push({
        client_link_id: row.id,
        client_name: row.client_name,
        realm_id: row.qbo_realm_id,
        expired_for_days: expiredForDays,
        status: "skipped",
        error: "dry_run — not probed (probing rotates the refresh token; run without dry_run to actually test+persist)",
      });
      continue;
    }

    try {
      const tokens = await refreshAccessToken(row.qbo_refresh_token);
      // Success — persist the freshly-minted access_token AND the rotated
      // refresh_token (Intuit rotates it on every refresh; losing it kills
      // the chain).
      {
        const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
        await service
          .from("client_links")
          .update({
            qbo_access_token: tokens.access_token,
            qbo_refresh_token: tokens.refresh_token,
            qbo_token_expires_at: newExpiry,
          } as any)
          .eq("id", row.id);
      }
      results.push({
        client_link_id: row.id,
        client_name: row.client_name,
        realm_id: row.qbo_realm_id,
        expired_for_days: expiredForDays,
        status: "healthy",
      });
    } catch (err: any) {
      const message = String(err?.message || err);
      // Try to pull Intuit's error_code out of the message for at-a-glance
      // triage. Format: `QBO token refresh failed: 400 {"error":"invalid_grant"...}`
      const codeMatch = message.match(/"x_error_reason"\s*:\s*"([^"]+)"/);
      results.push({
        client_link_id: row.id,
        client_name: row.client_name,
        realm_id: row.qbo_realm_id,
        expired_for_days: expiredForDays,
        status: "dead",
        error: message.slice(0, 500),
        error_code: codeMatch?.[1],
      });
    }
  }

  // Audit log — useful both for "did the bookkeeper run this?" and for
  // tracking the rate of dead tokens over time once it runs on a cron.
  const summary = {
    probed: results.length,
    healthy: results.filter((r) => r.status === "healthy").length,
    dead: results.filter((r) => r.status === "dead").length,
  };
  await service.from("audit_log").insert({
    event_type: "qbo_token_health_probe",
    user_id: user.id,
    request_payload: {
      limit,
      dry_run: dryRun,
      skip_recent_hours: skipRecentHours,
      ...summary,
      dead_clients: results
        .filter((r) => r.status === "dead")
        .map((r) => ({ client: r.client_name, code: r.error_code })),
    } as any,
  });

  return NextResponse.json({
    ok: true,
    ...summary,
    dry_run: dryRun,
    results,
  });
}
