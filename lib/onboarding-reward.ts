/**
 * Onboarding thank-you reward — the $5 Starbucks gift card a client gets for
 * finishing the portal onboarding (video → business details → book the call).
 *
 * SNAP does not talk to Tremendous directly. It POSTs a small JSON payload to an
 * outbound webhook (Zapier / Make), and that automation issues the gift card via
 * Tremendous. Keeping the vendor on the far side of a webhook means swapping
 * providers never touches this codebase, and no gift-card credentials live here.
 *
 * This spends real money, so the design is deliberately paranoid:
 *
 *   1. EXACTLY ONCE. Before sending, we atomically "claim" the reward with a
 *      conditional UPDATE (`... WHERE portal_onboarding->>'reward_claimed_at' IS
 *      NULL`). Two concurrent completions both read null, both try to claim, and
 *      Postgres lets exactly one win — the loser gets zero rows back and returns
 *      without sending. A naive read-then-write would double-send here.
 *   2. NEVER FOR STAFF. Admin impersonation is excluded — a senior clicking
 *      through a client's wizard must not trigger a real gift card.
 *   3. NEVER FOR TEST ACCOUNTS. Obvious demo/test clients are skipped.
 *   4. FAILURES ARE LOUD, NOT SILENT. A failed webhook keeps the claim (so we
 *      can't double-send on retry) and records the error + an audit event, so a
 *      human can see the client is owed a card. Deliberately no auto-retry.
 */

import { readOnboardingState, ONBOARDING_REWARD_LABEL } from "./portal-onboarding";

export interface RewardOutcome {
  sent: boolean;
  /** Why nothing was sent — for logs and the wizard's reward step. */
  reason?:
    | "already_claimed"
    | "impersonating"
    | "test_account"
    | "not_configured"
    | "no_recipient"
    | "webhook_failed";
  error?: string;
}

/** Obvious non-clients — never spend money on these. */
function looksLikeTestAccount(name: string | null | undefined, email: string | null | undefined): boolean {
  const hay = `${name || ""} ${email || ""}`.toLowerCase();
  return /\b(test|demo|sample|example|dummy|sandbox)\b/.test(hay) || hay.includes("@example.com");
}

/**
 * Send the onboarding reward for a client, at most once, ever.
 *
 * Best-effort by contract: it never throws, so a webhook problem can't fail the
 * client's "finish onboarding" request. The caller can surface `outcome` but
 * should not block on it.
 */
export async function maybeSendOnboardingReward(
  service: any,
  clientLinkId: string,
  opts?: { impersonating?: boolean }
): Promise<RewardOutcome> {
  try {
    // Staff clicking through a client's wizard must not spend money.
    if (opts?.impersonating) return { sent: false, reason: "impersonating" };

    const webhookUrl = process.env.ONBOARDING_REWARD_WEBHOOK_URL;

    const { data: client } = await service
      .from("client_links")
      .select("id, client_name, client_email, contact_first_name, contact_last_name, portal_onboarding")
      .eq("id", clientLinkId)
      .single();
    if (!client) return { sent: false, reason: "no_recipient" };

    const state = readOnboardingState(client);
    if (state.reward_claimed_at) return { sent: false, reason: "already_claimed" };

    if (looksLikeTestAccount(client.client_name, client.client_email)) {
      return { sent: false, reason: "test_account" };
    }
    const email = (client.client_email || "").trim();
    if (!email) return { sent: false, reason: "no_recipient" };
    if (!webhookUrl) return { sent: false, reason: "not_configured" };

    // ── The atomic claim. Only the writer that flips reward_claimed_at from
    //    NULL proceeds; everyone else sees zero rows and stops here. ──
    const now = new Date().toISOString();
    const { data: claimed } = await service
      .from("client_links")
      .update({ portal_onboarding: { ...state, reward_claimed_at: now } })
      .eq("id", clientLinkId)
      .filter("portal_onboarding->>reward_claimed_at", "is", null)
      .select("id");
    if (!claimed || claimed.length === 0) {
      // Someone else claimed it between our read and our write.
      return { sent: false, reason: "already_claimed" };
    }

    const recipientName =
      [client.contact_first_name, client.contact_last_name].filter(Boolean).join(" ").trim() ||
      client.client_name ||
      "there";

    let ok = false;
    let errText = "";
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "onboarding_completed",
          reward: ONBOARDING_REWARD_LABEL,
          amount_usd: 5,
          client_link_id: clientLinkId,
          client_name: client.client_name,
          recipient_name: recipientName,
          recipient_email: email,
          completed_at: now,
        }),
      });
      ok = res.ok;
      if (!ok) errText = `webhook returned ${res.status}`;
    } catch (e: any) {
      errText = String(e?.message || e).slice(0, 300);
    }

    // Record the result on the claim we already hold — the claim stays either
    // way, so a retry can never issue a second card.
    const finalState = {
      ...state,
      reward_claimed_at: now,
      reward_sent_at: ok ? now : null,
      reward_error: ok ? null : errText,
    };
    await service.from("client_links").update({ portal_onboarding: finalState }).eq("id", clientLinkId);

    try {
      await service.from("audit_log").insert({
        event_type: ok ? "onboarding_reward_sent" : "onboarding_reward_failed",
        request_payload: {
          client_link_id: clientLinkId,
          client_name: client.client_name,
          recipient_email: email,
          reward: ONBOARDING_REWARD_LABEL,
          error: ok ? null : errText,
        } as any,
      } as any);
    } catch {
      /* audit is best-effort */
    }

    return ok ? { sent: true } : { sent: false, reason: "webhook_failed", error: errText };
  } catch (e: any) {
    // Never let the reward break the client's completion request.
    return { sent: false, reason: "webhook_failed", error: String(e?.message || e).slice(0, 300) };
  }
}
