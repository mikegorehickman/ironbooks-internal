import { emailPortalUsersAboutMessage } from "@/lib/client-comms";

/**
 * Billing dunning / collections.
 *
 * Past-due = a CONFIRMED failed billing_payment with no collected payment in the
 * same period. We deliberately do NOT treat "no payment recorded" as past-due —
 * that could be an unmatched/unmapped Stripe payment (a reconciliation gap), and
 * we must never lock out or harass a paying client over our own mapping gap.
 *
 * Reminders go out on a cadence (email + in-portal notification) until paid.
 * Portal access is suspended only after a grace period + several reminders, and
 * ONLY when env DUNNING_AUTOSUSPEND='true' — otherwise dunning just reminds and
 * leaves access on (so you can validate before enabling the hard cutoff).
 */
const REMIND_EVERY_DAYS = 4;
const GRACE_DAYS = 10;
const MIN_REMINDERS_BEFORE_HOLD = 3;
const DAY = 86_400_000;

export interface DunningResult {
  pastDue: number;
  remindersSent: number;
  suspended: number;
  cleared: number;
  autoSuspendOn: boolean;
}

export async function runDunning(
  service: any,
  opts: { origin: string; actorId?: string | null }
): Promise<DunningResult> {
  const autoSuspend = process.env.DUNNING_AUTOSUSPEND === "true";
  const now = Date.now();

  // Confirmed past-due: failed payment with no collected in the same period.
  const { data: pays } = await service
    .from("billing_payments")
    .select("client_link_id, period_year, period_month, status");
  const collected = new Set<string>();
  const failed = new Map<string, { y: number; m: number }>();
  for (const p of ((pays as any[]) || [])) {
    const key = `${p.client_link_id}|${p.period_year}|${p.period_month}`;
    if (p.status === "collected") collected.add(key);
  }
  for (const p of ((pays as any[]) || [])) {
    if (p.status !== "failed") continue;
    const key = `${p.client_link_id}|${p.period_year}|${p.period_month}`;
    if (!collected.has(key)) failed.set(p.client_link_id, { y: p.period_year, m: p.period_month });
  }
  const pastDueIds = new Set(failed.keys());

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, portal_billing_hold, billing_past_due_since")
    .eq("is_active", true);
  const { data: subs } = await (service as any)
    .from("billing_subscriptions")
    .select("client_link_id, last_reminder_at, reminder_count, dunning_exempt");
  const subByClient = new Map(((subs as any[]) || []).map((s) => [s.client_link_id, s]));

  const result: DunningResult = { pastDue: pastDueIds.size, remindersSent: 0, suspended: 0, cleared: 0, autoSuspendOn: autoSuspend };

  for (const c of ((clients as any[]) || [])) {
    const sub = subByClient.get(c.id) || {};
    if (pastDueIds.has(c.id)) {
      if (sub.dunning_exempt) continue;
      // Stamp past-due start once.
      if (!c.billing_past_due_since) {
        await service.from("client_links").update({ billing_past_due_since: new Date(now).toISOString() } as any).eq("id", c.id);
      }
      const pastDueSince = c.billing_past_due_since ? new Date(c.billing_past_due_since).getTime() : now;
      const lastReminder = sub.last_reminder_at ? new Date(sub.last_reminder_at).getTime() : 0;
      const count = sub.reminder_count || 0;

      // Reminder due? (first one immediately, then every REMIND_EVERY_DAYS.)
      if (!lastReminder || now - lastReminder >= REMIND_EVERY_DAYS * DAY) {
        const clientName = c.client_name || "your business";
        const body = [
          `Hi — our records show a recent payment for your Ironbooks bookkeeping didn't go through, so your account is past due.`,
          ``,
          `Please update your payment method to keep your books and portal active. If you've already taken care of this, thank you — you can ignore this message.`,
          ``,
          `Questions? Just reply here or email admin@ironbooks.com.`,
        ].join("\n");
        try {
          await service.from("client_communications").insert({
            client_link_id: c.id, sender_user_id: opts.actorId || null,
            direction: "to_client", kind: "notification",
            subject: "Action needed: your Ironbooks payment is past due", body,
          });
        } catch { /* ignore */ }
        await emailPortalUsersAboutMessage(service, {
          clientLinkId: c.id, clientName, kind: "notification",
          subject: "Action needed: your Ironbooks payment is past due", body,
          portalOrigin: opts.origin, portalPath: "/portal/billing", ctaLabel: "Update payment",
        }).catch(() => {});
        await (service as any).from("billing_subscriptions").upsert(
          { client_link_id: c.id, last_reminder_at: new Date(now).toISOString(), reminder_count: count + 1, updated_at: new Date(now).toISOString() },
          { onConflict: "client_link_id" }
        );
        result.remindersSent++;
      }

      // Auto-suspend (gated): after grace + several reminders.
      if (autoSuspend && !c.portal_billing_hold && count + 1 >= MIN_REMINDERS_BEFORE_HOLD && now - pastDueSince >= GRACE_DAYS * DAY) {
        await service.from("client_links").update({
          portal_billing_hold: true, billing_hold_at: new Date(now).toISOString(),
          billing_hold_reason: "Past due — automated billing hold",
        } as any).eq("id", c.id);
        result.suspended++;
      }
    } else {
      // No longer past-due → clear hold + reset dunning if they were flagged.
      if (c.portal_billing_hold || c.billing_past_due_since) {
        await service.from("client_links").update({
          portal_billing_hold: false, billing_hold_at: null, billing_hold_reason: null, billing_past_due_since: null,
        } as any).eq("id", c.id);
        await (service as any).from("billing_subscriptions").update({ last_reminder_at: null, reminder_count: 0 }).eq("client_link_id", c.id);
        result.cleared++;
      }
    }
  }

  return result;
}
