/** Tests for the portal invite / re-invite email (lib/client-comms.ts).
 *  Run: npx tsx scripts/test-portal-invite-email.ts
 *
 *  These are structural, not aesthetic: the failures that actually reach a
 *  client are a malformed From header, an unescaped client name, a template
 *  literal that didn't interpolate, or a link the button doesn't carry.
 */
const captured: any[] = [];
(globalThis as any).fetch = async (_u: string, init: any) => {
  captured.push(JSON.parse(init.body));
  return { ok: true, json: async () => ({ id: "test" }) } as any;
};
process.env.RESEND_API_KEY = "test-key";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }

async function main() {
  const { sendPortalInviteEmail } = await import("../lib/client-comms");
  const LINK = "https://snap.ironbooks.com/auth/activate?token=abc123";

  await sendPortalInviteEmail({
    to: "c@example.com", fullName: "Dave Thompson", clientName: "Thompson Painting Ltd.",
    actionLink: LINK, isResend: true, bookkeeperName: "Lisa Chen",
  });
  await sendPortalInviteEmail({
    to: "c@example.com", fullName: "Dave Thompson", clientName: "Thompson Painting Ltd.",
    actionLink: LINK, isResend: false,
  });
  // Hostile inputs: a client name with HTML, and no name at all.
  await sendPortalInviteEmail({
    to: "c@example.com", fullName: "", clientName: `Bob's <script>alert(1)</script> Painting & Co`,
    actionLink: LINK, isResend: true,
  });

  const [resend, first, hostile] = captured;

  // ── From header. The bug this caught in review: resolveFromEmail returns a
  //    FULL header ("Ironbooks <addr>"), so wrapping it produced nested angle
  //    brackets — a malformed header that mail servers reject or mangle.
  ok("personal From uses the bookkeeper's first name", /^Lisa at Ironbooks </.test(resend.from));
  ok("From has exactly one pair of angle brackets",
    (resend.from.match(/</g) || []).length === 1 && (resend.from.match(/>/g) || []).length === 1);
  // sendResendEmail resolves the default From before building the payload, so
  // the captured value is the brand header — not undefined. Assert on what
  // actually goes out: brand name, no personal prefix.
  ok("no bookkeeper ⇒ From is the brand default, with no personal prefix",
    /^Ironbooks </.test(first.from) && !first.from.includes(" at Ironbooks"));

  // ── Subject lines lead with the client's name and a reason to open.
  ok("resend subject is personalised", resend.subject.startsWith("Dave,"));
  ok("first-invite subject is personalised", first.subject.startsWith("Dave,"));
  ok("subjects differ between resend and first invite", resend.subject !== first.subject);
  ok("subject is short enough not to truncate on mobile", resend.subject.length <= 60);
  ok("no-name client still gets a usable subject", hostile.subject.startsWith("there,"));

  // ── The link must be in the button AND as pasteable text, in both parts.
  for (const [label, m] of [["resend", resend], ["first", first]] as const) {
    ok(`${label}: html carries the action link twice (button + fallback)`,
      (m.html.match(/auth\/activate\?token=abc123/g) || []).length >= 2);
    ok(`${label}: text part carries the action link`, m.text.includes(LINK));
    ok(`${label}: no unresolved template literal`, !m.html.includes("${") && !m.text.includes("${"));
  }

  // ── Escaping. A client name is operator-entered data that lands in HTML.
  ok("script tag in client name is escaped", !hostile.html.includes("<script>"));
  ok("escaped form is present instead", hostile.html.includes("&lt;script&gt;"));
  ok("ampersand in client name is escaped", hostile.html.includes("&amp; Co"));

  // ── Deliverability / rendering basics.
  ok("no remote images (clients block them by default)", !/<img/i.test(resend.html));
  ok("no <script> in the template itself", !/<script/i.test(resend.html));
  ok("preheader is set", resend.html.includes("max-height:0"));
  ok("well under Gmail's 102KB clipping threshold", resend.html.length < 20000);
  ok("text part stands alone (not a stripped HTML dump)",
    resend.text.includes("Hi Dave,") && !resend.text.includes("<div"));

  // ── The expiry we STATE must never exceed the real link lifetime.
  //
  // We deliberately under-promise: the copy says 3 days, the link lives 7. That
  // gives urgency without locking anyone out on day four — which matters doubly
  // for the re-invite, whose whole job is rescuing someone who already couldn't
  // sign in. The invariant is STATED <= ACTUAL and it must never invert. The
  // test can import both numbers; the email module can't (circular).
  const { STATED_LINK_DAYS } = await import("../lib/client-comms");
  const { ACTIVATION_TTL_DAYS } = await import("../lib/portal-invite");
  ok(`stated expiry (${STATED_LINK_DAYS}d) never exceeds the real TTL (${ACTIVATION_TTL_DAYS}d)`,
    STATED_LINK_DAYS <= ACTIVATION_TTL_DAYS);
  ok("stated expiry is a positive number of days", STATED_LINK_DAYS >= 1);

  for (const [label, m] of [["resend", resend], ["first", first]] as const) {
    ok(`${label}: html states the expiry in days`, m.html.includes(`${STATED_LINK_DAYS} days`));
    ok(`${label}: text states the expiry in days`, m.text.includes(`${STATED_LINK_DAYS} days`));
    // Prominent, not buried: it appears beside the button AND in the footer.
    ok(`${label}: expiry appears twice in the html (near CTA + footer)`,
      (m.html.match(new RegExp(`expires in ${STATED_LINK_DAYS} days`, "g")) || []).length >= 2);
    ok(`${label}: uses "expires in", not vague wording`,
      m.text.includes("expires in") && !m.text.includes("a little while"));
  }

  // ── Value, not just a link — the whole point of the rewrite.
  ok("resend body names what's waiting, not just the link",
    resend.text.includes("Know what you're owed") && resend.text.includes("Ask us anything"));
  ok("covers financial literacy, not only reporting",
    resend.text.includes("Learn the numbers that move profit"));

  // ── NO FRESHNESS CLAIMS (Mike, 2026-07-28) ────────────────────────────────
  // We cannot guarantee at send time that a client's books are current — and a
  // client who logs in expecting a finished month and finds work in progress
  // trusts the next email less. This guard exists because that copy is the
  // tempting thing to write, so it will get re-suggested.
  const FRESHNESS_CLAIMS = [
    "up to date", "up-to-date", "all caught up", "fully reconciled",
    "books are ready", "books are current", "everything is done",
    "this month is closed", "finalised", "finalized",
  ];
  for (const m of [resend, first, hostile]) {
    for (const claim of FRESHNESS_CLAIMS) {
      ok(`no freshness claim "${claim}" in html`, !m.html.toLowerCase().includes(claim));
      ok(`no freshness claim "${claim}" in text`, !m.text.toLowerCase().includes(claim));
    }
  }
  ok("reassures there's no password", resend.text.includes("no password to remember"));
  ok("resend acknowledges the expired link", resend.text.includes("expired"));

  console.log(`\nportal-invite-email: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
