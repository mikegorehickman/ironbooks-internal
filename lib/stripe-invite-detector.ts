import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceSupabase } from "./supabase";
import { getValidToken } from "./qbo";
import { fetchStripeDeposits } from "./qbo-stripe-recon";

/**
 * Background detector for the "Stripe deposits exist in QBO but client
 * isn't connected" workflow. Runs nightly via Vercel Cron (or on demand
 * via the admin manual-trigger endpoint).
 *
 * For each QBO-connected client without an active Stripe connection
 * AND not previously dismissed, it scans the last 3 months of QBO
 * deposits for Stripe-tagged ones. When found, it writes the count +
 * total back to client_links so the dashboard widget can render a
 * one-click "Send invite" card.
 *
 * Why 3 months: covers a current quarter's worth of activity without
 * burning unnecessary QBO API calls on long-tail history. Older Stripe
 * activity that didn't surface in the last 3mo either trickled to zero
 * (client churned off Stripe) or will reappear soon.
 *
 * Fail-soft: per-client errors are logged and skipped. One bad QBO
 * token doesn't break the whole sweep.
 */

const SCAN_WINDOW_DAYS = 90;

type ClientRow = {
  id: string;
  client_name: string;
  qbo_realm_id: string | null;
  stripe_connection_status: string | null;
  stripe_invite_dismissed_at: string | null;
};

type SweepResult = {
  scanned: number;
  matched: number;
  errors: Array<{ client_link_id: string; client_name: string; error: string }>;
};

export async function runStripeInviteDetector(opts?: {
  service?: SupabaseClient;
  /** Limit to a single client (for the admin manual-trigger path). */
  onlyClientLinkId?: string;
}): Promise<SweepResult> {
  const service = opts?.service ?? createServiceSupabase();
  const result: SweepResult = { scanned: 0, matched: 0, errors: [] };

  // Candidate clients: active, have QBO connected, NOT already Stripe-
  // connected, NOT previously dismissed, AND NOT flagged as "doesn't
  // use Stripe" by a bookkeeper (the stripe_not_required gate).
  //
  // Cast the whole builder to `any` because the migration-22 and
  // migration-27 columns aren't in the regenerated supabase types yet;
  // chaining with full inference triggers "type instantiation is
  // excessively deep." Runtime is correct.
  let q: any = service
    .from("client_links")
    .select(
      "id, client_name, qbo_realm_id, stripe_connection_status, stripe_invite_dismissed_at"
    )
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .is("stripe_invite_dismissed_at", null)
    .filter("stripe_not_required", "eq", false);
  if (opts?.onlyClientLinkId) {
    q = q.eq("id", opts.onlyClientLinkId);
  }
  const { data: candidates, error: candidatesErr } = await q;
  if (candidatesErr) {
    throw new Error(`Detector candidate fetch failed: ${candidatesErr.message}`);
  }

  // Cast through unknown because the migration-22 columns aren't in the
  // regenerated supabase types yet. Runtime shape is correct.
  const eligible = (((candidates as unknown) as ClientRow[]) || []).filter(
    (c) => c.stripe_connection_status !== "connected"
  );

  const now = Date.now();
  const end = new Date(now).toISOString().slice(0, 10);
  const start = new Date(now - SCAN_WINDOW_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  for (const c of eligible) {
    result.scanned++;
    if (!c.qbo_realm_id) continue;
    try {
      const accessToken = await getValidToken(c.id, service as any);
      const deposits = await fetchStripeDeposits(
        c.qbo_realm_id,
        accessToken,
        start,
        end
      );
      const count = deposits.length;
      const total = deposits.reduce((s, d) => s + Number(d.amount || 0), 0);
      const nowIso = new Date().toISOString();

      // Write back: if we found any, set suggested_at; if we didn't,
      // just record that we scanned. This lets the widget surface only
      // rows with non-null suggested_at — and any "previously suggested
      // but now zero" rows get their count zeroed and drop out.
      await service
        .from("client_links")
        .update({
          stripe_invite_last_scan_at: nowIso,
          stripe_invite_deposit_count: count,
          stripe_invite_deposit_total: total,
          stripe_invite_suggested_at: count > 0 ? nowIso : null,
        } as any)
        .eq("id", c.id);

      if (count > 0) result.matched++;
    } catch (err: any) {
      const msg = String(err?.message || err).slice(0, 300);
      result.errors.push({
        client_link_id: c.id,
        client_name: c.client_name,
        error: msg,
      });
      // Still record that we attempted, so failed-token clients don't get
      // hammered on every run.
      try {
        await service
          .from("client_links")
          .update({
            stripe_invite_last_scan_at: new Date().toISOString(),
          } as any)
          .eq("id", c.id);
      } catch {
        // non-fatal
      }
    }
  }

  return result;
}
