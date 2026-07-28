/**
 * Client-facing portal onboarding wizard — state + gating helpers.
 *
 * A won client lands in their portal and is guided through: watch the intro
 * video → complete the foundation intake (which now lives in SNAP, replacing
 * the GHL form) → send us documents. Soft-nag gate: the wizard is the default
 * landing and a banner persists across the portal until the FORM and DOCS are
 * done (video optional).
 */

export interface PortalOnboardingState {
  video_watched_at?: string | null;
  form_submitted_at?: string | null;
  /** Onboarding call booked (client-confirmed, or authoritatively by the GHL
   *  appointment webhook). */
  call_booked_at?: string | null;
  /** Legacy: documents step, retired from the wizard 2026-07-27 (statements are
   *  now requested by the bookkeeper). Kept so historic rows still read. */
  docs_provided_at?: string | null;
  completed_at?: string | null;
  accounts_attested?: boolean;
  accounts_attested_at?: string | null;
  /** In-progress answers from the paged intake form, saved on every "Next". */
  form_draft?: any | null;
  form_draft_page?: number | null;
  form_saved_at?: string | null;
  /** The submitted intake, verbatim — most of the 29 fields have no column. */
  form_answers?: any | null;
  /** Thank-you reward (see lib/onboarding-reward.ts). `claimed` is the atomic
   *  latch that makes sending exactly-once; `sent` records success. */
  reward_claimed_at?: string | null;
  reward_sent_at?: string | null;
  reward_error?: string | null;
}

export function readOnboardingState(row: { portal_onboarding?: any } | null | undefined): PortalOnboardingState {
  const s = (row?.portal_onboarding || {}) as PortalOnboardingState;
  return {
    video_watched_at: s.video_watched_at ?? null,
    form_submitted_at: s.form_submitted_at ?? null,
    call_booked_at: s.call_booked_at ?? null,
    docs_provided_at: s.docs_provided_at ?? null,
    completed_at: s.completed_at ?? null,
    accounts_attested: !!s.accounts_attested,
    accounts_attested_at: s.accounts_attested_at ?? null,
    form_draft: s.form_draft ?? null,
    form_draft_page: s.form_draft_page ?? null,
    form_saved_at: s.form_saved_at ?? null,
    form_answers: s.form_answers ?? null,
    reward_claimed_at: s.reward_claimed_at ?? null,
    reward_sent_at: s.reward_sent_at ?? null,
    reward_error: s.reward_error ?? null,
  };
}

/**
 * The wizard is "done enough" once the intake form is in AND the onboarding call
 * is booked — those are the two things the team actually needs from the client.
 * (The video is encouraged but never blocks.)
 *
 * Documents used to be required here; they moved out of the wizard on
 * 2026-07-27 — the bookkeeper requests statements directly instead. Clients who
 * finished under the old rule already carry `completed_at`, so they stay done.
 */
export function onboardingRequiredDone(s: PortalOnboardingState): boolean {
  return !!s.form_submitted_at && !!s.call_booked_at;
}

export function onboardingComplete(s: PortalOnboardingState): boolean {
  return !!s.completed_at || onboardingRequiredDone(s);
}

/**
 * Should this client see the onboarding wizard at all? Only pre-production
 * clients who haven't finished it — an established/live client never gets an
 * onboarding screen. Gate on the client_links row (no extra query).
 */
export function shouldShowOnboarding(
  client: { status?: string | null; cleanup_completed_at?: string | null; daily_recon_enabled?: boolean | null; portal_onboarding?: any } | null | undefined
): boolean {
  if (!client) return false;
  const s = readOnboardingState(client);
  if (onboardingComplete(s)) return false;
  // Live/production or cleanup-signed-off clients are past onboarding.
  if (client.daily_recon_enabled && client.cleanup_completed_at) return false;
  if (client.cleanup_completed_at) return false;
  // Show for new/onboarding + early-cleanup clients (pre-books).
  return client.status === "onboarding" || !client.cleanup_completed_at;
}

/** Intro video URL — set NEXT_PUBLIC_ONBOARDING_VIDEO_URL to a Loom/YT/Vimeo
 * embed. Empty → the wizard shows a "video coming soon" placeholder, never a
 * broken frame. */
export function onboardingVideoUrl(): string {
  return toEmbedUrl(process.env.NEXT_PUBLIC_ONBOARDING_VIDEO_URL || "");
}

/**
 * Turn a video link into one that can actually be iframed.
 *
 * The share/watch URL you copy from Vimeo, YouTube or Loom is NOT embeddable —
 * those pages send X-Frame-Options: DENY, so the wizard renders "refused to
 * connect" (hit live 2026-07-27). Only the player/embed host works. Rather than
 * make whoever sets the env var remember that, accept any of the usual formats
 * and convert:
 *
 *   vimeo.com/123            → player.vimeo.com/video/123
 *   vimeo.com/123/abc        → player.vimeo.com/video/123?h=abc   (unlisted)
 *   youtube.com/watch?v=ID   → youtube.com/embed/ID
 *   youtu.be/ID              → youtube.com/embed/ID
 *   loom.com/share/ID        → loom.com/embed/ID
 *
 * Already-embeddable URLs and anything unrecognized pass through untouched.
 */
export function toEmbedUrl(raw: string): string {
  const url = (raw || "").trim();
  if (!url) return "";

  // Vimeo — unlisted videos carry a privacy hash as a second path segment.
  const vimeo = url.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:\/([A-Za-z0-9]+))?/);
  if (vimeo) {
    const [, id, hash] = vimeo;
    return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
  }

  // YouTube watch pages and youtu.be short links.
  const ytWatch = url.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?(.*)$/);
  if (ytWatch) {
    const params = new URLSearchParams(ytWatch[1]);
    const id = params.get("v");
    if (id) {
      const start = params.get("t") || params.get("start");
      return `https://www.youtube.com/embed/${id}${start ? `?start=${String(start).replace(/\D/g, "")}` : ""}`;
    }
  }
  const ytShort = url.match(/^https?:\/\/youtu\.be\/([A-Za-z0-9_-]+)/);
  if (ytShort) return `https://www.youtube.com/embed/${ytShort[1]}`;

  // Loom share links.
  const loom = url.match(/^https?:\/\/(?:www\.)?loom\.com\/share\/([A-Za-z0-9]+)/);
  if (loom) return `https://www.loom.com/embed/${loom[1]}`;

  return url;
}

/**
 * Onboarding-call booking calendar — set NEXT_PUBLIC_OB_CALL_CALENDAR_URL to the
 * GHL calendar embed URL. Empty → the step explains that the team will reach out
 * to schedule, and the client can still confirm a call booked another way, so an
 * unset env var never dead-ends the wizard.
 */
export function onboardingCallCalendarUrl(): string {
  return process.env.NEXT_PUBLIC_OB_CALL_CALENDAR_URL || "";
}

/** Reward copy — kept in one place so the wizard and the webhook agree. */
export const ONBOARDING_REWARD_LABEL = "$5 Starbucks gift card";
