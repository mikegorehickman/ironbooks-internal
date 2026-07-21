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
  docs_provided_at?: string | null;
  completed_at?: string | null;
  accounts_attested?: boolean;
}

export function readOnboardingState(row: { portal_onboarding?: any } | null | undefined): PortalOnboardingState {
  const s = (row?.portal_onboarding || {}) as PortalOnboardingState;
  return {
    video_watched_at: s.video_watched_at ?? null,
    form_submitted_at: s.form_submitted_at ?? null,
    docs_provided_at: s.docs_provided_at ?? null,
    completed_at: s.completed_at ?? null,
    accounts_attested: !!s.accounts_attested,
  };
}

/** The wizard is "done enough" once the intake form + documents are handled.
 * (Video is encouraged but never blocks.) */
export function onboardingRequiredDone(s: PortalOnboardingState): boolean {
  return !!s.form_submitted_at && !!s.docs_provided_at;
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
  return process.env.NEXT_PUBLIC_ONBOARDING_VIDEO_URL || "";
}
