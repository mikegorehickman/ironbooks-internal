import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";

/**
 * GET /api/fleet/qbo-health-check
 *
 * Actively probes every active client's QBO connection by attempting a
 * refresh (via getValidToken). The static `qbo_token_expires_at` column
 * is the access-token expiry — usually <1h old — and tells you nothing
 * about whether the REFRESH token works. This endpoint does the real
 * test: it tries to refresh, and reports back which clients have a
 * dead refresh token (invalid_grant) vs which refreshed successfully.
 *
 * Admin/lead only — expensive (one QBO call per client). Don't put it
 * on a hot path. Runs sequentially with a short delay between calls
 * to stay under QBO rate limits.
 *
 * Returns JSON summary + per-client detail. The Fleet Health dashboard
 * can call this periodically (e.g. nightly cron) to populate a
 * `qbo_refresh_last_checked_at` column, which Panel C should display
 * instead of the misleading access-token expiry.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 800;

interface ClientResult {
  client_link_id: string;
  client_name: string;
  qbo_realm_id: string | null;
  status: "ok" | "invalid_grant" | "no_realm" | "other_error";
  detail: string;
  // For the "ok" case — the new access-token expiry timestamp.
  new_expiry: string | null;
}

export async function GET(_request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead"].includes(role)) {
    return NextResponse.json({ error: "Forbidden — admin/lead only" }, { status: 403 });
  }

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, qbo_token_expires_at")
    .eq("is_active", true)
    .order("client_name");

  const results: ClientResult[] = [];
  for (const c of (clients as any[]) || []) {
    if (!c.qbo_realm_id) {
      results.push({
        client_link_id: c.id,
        client_name: c.client_name,
        qbo_realm_id: null,
        status: "no_realm",
        detail: "Never connected to QBO.",
        new_expiry: null,
      });
      continue;
    }

    try {
      // This is the actual test — getValidToken refreshes if needed,
      // and the refresh either succeeds (token valid) or throws with
      // a recognizable error if the refresh_token is dead.
      await getValidToken(
        c.id,
        service as any,
        "ironbooks/api/fleet/qbo-health-check"
      );
      // Re-read the row to capture the new expiry (getValidToken writes
      // it back to client_links on successful refresh).
      const { data: fresh } = await service
        .from("client_links")
        .select("qbo_token_expires_at")
        .eq("id", c.id)
        .single();
      results.push({
        client_link_id: c.id,
        client_name: c.client_name,
        qbo_realm_id: c.qbo_realm_id,
        status: "ok",
        detail: "Refresh succeeded.",
        new_expiry: (fresh as any)?.qbo_token_expires_at || null,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      // getValidToken() rewrites invalid_grant into a friendly remediation
      // string ("Your QuickBooks connection has expired or been disconnected.
      // Please reconnect QBO from the client's Settings...") so the regex
      // has to recognize BOTH the raw OAuth error AND the friendly version.
      // Without this every dead-refresh-token client landed in other_error.
      if (
        /invalid_grant|invalid_token|token.*revoked|Incorrect Token type/i.test(msg) ||
        /(QuickBooks connection|QBO connection).*(expired|disconnected|no longer valid)/i.test(msg) ||
        /reconnect QBO/i.test(msg)
      ) {
        results.push({
          client_link_id: c.id,
          client_name: c.client_name,
          qbo_realm_id: c.qbo_realm_id,
          status: "invalid_grant",
          detail: "Refresh token dead — client must re-authorize QBO.",
          new_expiry: null,
        });
      } else {
        results.push({
          client_link_id: c.id,
          client_name: c.client_name,
          qbo_realm_id: c.qbo_realm_id,
          status: "other_error",
          detail: msg.slice(0, 300),
          new_expiry: null,
        });
      }
    }

    // QBO rate limit is ~500/min/realm but we're hitting different
    // realms across the loop. Tiny delay to stay polite to the OAuth
    // refresh endpoint specifically (separate quota).
    await new Promise((r) => setTimeout(r, 150));
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    invalid_grant: results.filter((r) => r.status === "invalid_grant").length,
    no_realm: results.filter((r) => r.status === "no_realm").length,
    other_error: results.filter((r) => r.status === "other_error").length,
    checked_at: new Date().toISOString(),
  };

  // Persist each result to qbo_connection_health so the /fleet/qbo-health
  // page can read the current state without re-probing. We upsert per
  // client — rolling first_failed_at forward when the streak continues,
  // clearing it when we go green.
  try {
    // Read existing health rows so we can roll first_failed_at correctly.
    const ids = results.map((r) => r.client_link_id);
    const { data: existingRows } = await (service as any)
      .from("qbo_connection_health")
      .select("client_link_id, status, first_failed_at, last_ok_at")
      .in("client_link_id", ids);
    const existingByClient = new Map<string, any>();
    for (const row of (existingRows as any[]) || []) {
      existingByClient.set(row.client_link_id, row);
    }

    const now = new Date().toISOString();
    const upserts = results.map((r) => {
      const prev = existingByClient.get(r.client_link_id);
      const wasFailing =
        prev && (prev.status === "invalid_grant" || prev.status === "other_error");
      const isFailingNow =
        r.status === "invalid_grant" || r.status === "other_error";
      return {
        client_link_id: r.client_link_id,
        status: r.status,
        last_checked_at: now,
        error_message: r.status === "ok" ? null : r.detail,
        // Roll last_ok_at forward on success; preserve existing otherwise.
        last_ok_at: r.status === "ok" ? now : prev?.last_ok_at ?? null,
        // first_failed_at:
        //   - Currently failing + was previously failing → keep prev (streak)
        //   - Currently failing + wasn't failing before → start streak now
        //   - Currently ok → clear (streak resolved)
        first_failed_at: isFailingNow
          ? wasFailing && prev?.first_failed_at
            ? prev.first_failed_at
            : now
          : null,
        // A verified-healthy probe means the re-auth completed — clear the
        // "reconnect started" marker so it can't linger as false comfort.
        ...(r.status === "ok"
          ? { reconnect_initiated_at: null, reconnect_initiated_by: null }
          : {}),
        updated_at: now,
      };
    });

    // Upsert in chunks (Supabase has a soft limit on a single insert).
    const BATCH = 200;
    for (let i = 0; i < upserts.length; i += BATCH) {
      await (service as any)
        .from("qbo_connection_health")
        .upsert(upserts.slice(i, i + BATCH), { onConflict: "client_link_id" });
    }
  } catch (writeErr: any) {
    // Persistence is observability — don't fail the probe response if it
    // breaks. The summary + per-client results above are still correct.
    console.warn(
      "[qbo-health-check] failed to persist results:",
      writeErr?.message
    );
  }

  // Sort: dead connections first, then errors, then ok.
  results.sort((a, b) => {
    const rank = (s: ClientResult["status"]) =>
      s === "invalid_grant" ? 0 : s === "other_error" ? 1 : s === "no_realm" ? 2 : 3;
    return rank(a.status) - rank(b.status);
  });

  return NextResponse.json({ summary, results });
}
