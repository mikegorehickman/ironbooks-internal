/** Unit tests for lib/portal-onboarding.ts.
 *  Run: npx tsx scripts/test-portal-onboarding.ts
 *
 *  Covers the embed-URL normalizer (a share link that can't be iframed is the
 *  failure we actually hit in production) and the completion gating.
 */
import {
  toEmbedUrl,
  readOnboardingState,
  onboardingRequiredDone,
  onboardingComplete,
  shouldShowOnboarding,
} from "../lib/portal-onboarding";
import { normalizeAnswers, EMPTY_ANSWERS } from "../lib/onboarding-answers";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: string, want: string) =>
  ok(`${name}${got === want ? "" : `  (got ${got}, want ${want})`}`, got === want);

// ── Vimeo: the case that broke live — watch pages refuse to be framed ──────
eq("vimeo watch → player",
  toEmbedUrl("https://vimeo.com/1234567890"),
  "https://player.vimeo.com/video/1234567890");
eq("vimeo www → player",
  toEmbedUrl("https://www.vimeo.com/1234567890"),
  "https://player.vimeo.com/video/1234567890");
eq("vimeo unlisted hash → ?h=",
  toEmbedUrl("https://vimeo.com/1234567890/a1b2c3d4e5"),
  "https://player.vimeo.com/video/1234567890?h=a1b2c3d4e5");
eq("vimeo player URL passes through",
  toEmbedUrl("https://player.vimeo.com/video/1234567890"),
  "https://player.vimeo.com/video/1234567890");
eq("vimeo player with hash passes through",
  toEmbedUrl("https://player.vimeo.com/video/1234567890?h=a1b2c3"),
  "https://player.vimeo.com/video/1234567890?h=a1b2c3");

// ── YouTube ────────────────────────────────────────────────────────────────
eq("youtube watch → embed",
  toEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  "https://www.youtube.com/embed/dQw4w9WgXcQ");
eq("youtube watch without www",
  toEmbedUrl("https://youtube.com/watch?v=dQw4w9WgXcQ"),
  "https://www.youtube.com/embed/dQw4w9WgXcQ");
eq("youtube watch keeps a start time",
  toEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"),
  "https://www.youtube.com/embed/dQw4w9WgXcQ?start=42");
eq("youtu.be short → embed",
  toEmbedUrl("https://youtu.be/dQw4w9WgXcQ"),
  "https://www.youtube.com/embed/dQw4w9WgXcQ");
eq("youtube embed passes through",
  toEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ"),
  "https://www.youtube.com/embed/dQw4w9WgXcQ");

// ── Loom ───────────────────────────────────────────────────────────────────
eq("loom share → embed",
  toEmbedUrl("https://www.loom.com/share/abc123def456"),
  "https://www.loom.com/embed/abc123def456");
eq("loom embed passes through",
  toEmbedUrl("https://www.loom.com/embed/abc123def456"),
  "https://www.loom.com/embed/abc123def456");

// ── Pass-through + safety ──────────────────────────────────────────────────
eq("empty stays empty", toEmbedUrl(""), "");
eq("whitespace is trimmed", toEmbedUrl("  https://vimeo.com/999  "), "https://player.vimeo.com/video/999");
eq("unknown host passes through", toEmbedUrl("https://cdn.example.com/intro.mp4"), "https://cdn.example.com/intro.mp4");
// A vimeo URL with no numeric id isn't a video — don't mangle it.
eq("vimeo non-video path untouched", toEmbedUrl("https://vimeo.com/ironbooks"), "https://vimeo.com/ironbooks");

// ── Completion gating: form + booked call (documents retired 2026-07-27) ───
{
  const s = readOnboardingState({ portal_onboarding: {} });
  ok("empty state is not done", !onboardingRequiredDone(s) && !onboardingComplete(s));
}
{
  const s = readOnboardingState({ portal_onboarding: { form_submitted_at: "2026-07-01" } });
  ok("form alone is not enough", !onboardingRequiredDone(s));
}
{
  const s = readOnboardingState({ portal_onboarding: { call_booked_at: "2026-07-01" } });
  ok("call alone is not enough", !onboardingRequiredDone(s));
}
{
  const s = readOnboardingState({
    portal_onboarding: { form_submitted_at: "2026-07-01", call_booked_at: "2026-07-02" },
  });
  ok("form + call = done", onboardingRequiredDone(s) && onboardingComplete(s));
}
{
  // Documents no longer gate anything.
  const s = readOnboardingState({
    portal_onboarding: { form_submitted_at: "2026-07-01", docs_provided_at: "2026-07-02" },
  });
  ok("form + docs no longer completes", !onboardingRequiredDone(s));
}
{
  // Anyone who finished under the OLD rule carries completed_at — never regress them.
  const s = readOnboardingState({
    portal_onboarding: { form_submitted_at: "2026-06-01", docs_provided_at: "2026-06-02", completed_at: "2026-06-02" },
  });
  ok("legacy completed clients stay complete", onboardingComplete(s));
}

// ── shouldShowOnboarding — the gate that hid the wizard on the test account ─
ok("brand-new client sees onboarding",
  shouldShowOnboarding({ status: "onboarding", cleanup_completed_at: null, daily_recon_enabled: false, portal_onboarding: {} }));
ok("cleanup-signed-off client does NOT",
  !shouldShowOnboarding({ status: "active", cleanup_completed_at: "2026-06-19", daily_recon_enabled: false, portal_onboarding: {} }));
ok("live production client does NOT",
  !shouldShowOnboarding({ status: "active", cleanup_completed_at: "2026-06-19", daily_recon_enabled: true, portal_onboarding: {} }));
ok("already-completed onboarding does NOT",
  !shouldShowOnboarding({ status: "onboarding", cleanup_completed_at: null, daily_recon_enabled: false, portal_onboarding: { completed_at: "2026-07-01" } }));

// The narrowing (2026-07-28): status must literally be "onboarding". The old
// `|| !cleanup_completed_at` fallback caught established clients mid-cleanup and
// would have greeted them with a first-run wizard.
ok("active client with cleanup NOT yet signed off does NOT (the Paint Boss case)",
  !shouldShowOnboarding({ status: "active", cleanup_completed_at: null, daily_recon_enabled: false, portal_onboarding: {} }));
ok("a null status does NOT",
  !shouldShowOnboarding({ status: null, cleanup_completed_at: null, daily_recon_enabled: false, portal_onboarding: {} }));
ok("an unrecognised status does NOT",
  !shouldShowOnboarding({ status: "paused", cleanup_completed_at: null, daily_recon_enabled: false, portal_onboarding: {} }));
// daily_recon_enabled and cleanup_completed_at are independent signals — either
// one alone means the client is live, so neither may fall through.
ok("daily-recon-on without a cleanup stamp does NOT",
  !shouldShowOnboarding({ status: "onboarding", cleanup_completed_at: null, daily_recon_enabled: true, portal_onboarding: {} }));
ok("cleanup stamp without daily-recon does NOT",
  !shouldShowOnboarding({ status: "onboarding", cleanup_completed_at: "2026-06-19", daily_recon_enabled: false, portal_onboarding: {} }));
ok("a genuinely new onboarding client still DOES",
  shouldShowOnboarding({ status: "onboarding", cleanup_completed_at: null, daily_recon_enabled: false, portal_onboarding: { video_watched_at: "2026-07-01" } }));

console.log(`\nportal-onboarding: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ── normalizeAnswers — the guard for the white-screen bug ──────────────────
// A draft saved before the client-module fix is missing every array/boolean/
// null field. The form maps over those arrays, so an undefined one is an
// "Application error", not a blank input.
{
  ok("EMPTY_ANSWERS is a real object, not a client-reference proxy",
    typeof EMPTY_ANSWERS === "object" && Object.keys(EMPTY_ANSWERS).length === 33);

  // The exact draft shape that crashed production: 21 scalar keys, no arrays.
  const brokenDraft = {
    email: "a@b.com", country: "USA", firstName: "Mike", lastName: "GH",
    fiscalYearEnd: "January", incorporationDate: "2026-07-02", lastTaxReturnYear: "2024",
  };
  const n = normalizeAnswers(brokenDraft);
  ok("missing staff becomes []", Array.isArray(n.staff) && n.staff.length === 0);
  ok("missing accounts becomes []", Array.isArray(n.accounts) && n.accounts.length === 0);
  ok("missing leaseFiles becomes []", Array.isArray(n.leaseFiles) && n.leaseFiles.length === 0);
  ok("missing taxReturnFile becomes null", n.taxReturnFile === null);
  ok("missing accountAttestation becomes false", n.accountAttestation === false);
  ok("missing string fields become ''", n.additionalNotes === "" && n.gstRegistered === "");
  ok("real values survive", n.email === "a@b.com" && n.country === "USA" && n.lastTaxReturnYear === "2024");

  // Fiscal year end is an <input type="date"> now — a month name can't render.
  eq("legacy month name is dropped", n.fiscalYearEnd, "");
  eq("ISO date is kept", normalizeAnswers({ fiscalYearEnd: "2026-12-31" }).fiscalYearEnd, "2026-12-31");
  eq("free-text date is dropped", normalizeAnswers({ fiscalYearEnd: "Dec 31" }).fiscalYearEnd, "");
  eq("ISO incorporation date is kept", n.incorporationDate, "2026-07-02");

  // Hostile / junk input must not throw — this runs on every page load.
  for (const junk of [null, undefined, 0, "nope", [], { staff: "not an array" }, { accounts: [null, 3] }]) {
    const r = normalizeAnswers(junk as any);
    ok(`junk input ${JSON.stringify(junk)} yields safe arrays`,
      Array.isArray(r.staff) && Array.isArray(r.accounts) && Array.isArray(r.leaseFiles));
  }
  ok("garbage account rows are coerced to the right shape",
    normalizeAnswers({ accounts: [null, 3] }).accounts.every(
      (r) => typeof r.institution === "string" && typeof r.accountType === "string" && typeof r.last4 === "string"));
  ok("country falls back to the default when blank",
    normalizeAnswers({}).country === "Canada");
}

console.log(`portal-onboarding (incl. normalizeAnswers): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
