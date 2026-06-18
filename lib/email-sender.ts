/**
 * Branded "from" resolution shared by every Resend send in the app.
 *
 * Resend's shared sandbox sender (onboarding@resend.dev) works with any API
 * key but is UNBRANDED and has poor deliverability — a real client email must
 * never go out from it. resolveFromEmail() walks the configured candidates in
 * priority order and returns the first that is set AND isn't the sandbox; if
 * none qualify it falls back to the branded production sender. This makes the
 * branded sender authoritative in CODE, so a missing or misconfigured
 * SUPPORT_FROM_EMAIL / MONTH_END_FROM_EMAIL env var can't silently downgrade a
 * client email to the sandbox domain.
 *
 * DEFAULT_FROM uses mail.ironbooks.com — the SAME verified Resend domain the
 * Supabase custom SMTP already sends auth emails from — so it works with the
 * same Resend account/key with no extra setup.
 */
const SANDBOX_SENDER = "onboarding@resend.dev";

export const DEFAULT_FROM = "Ironbooks <noreply@mail.ironbooks.com>";

export function resolveFromEmail(
  ...candidates: (string | undefined | null)[]
): string {
  for (const c of candidates) {
    const v = (c || "").trim();
    if (v && !v.toLowerCase().includes(SANDBOX_SENDER)) return v;
  }
  return DEFAULT_FROM;
}
