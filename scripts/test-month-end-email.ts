/** Tests for the month-end statements email (lib/month-end/email.ts).
 *  Run: npx tsx scripts/test-month-end-email.ts
 *
 *  The rule under test: never list a statement the client can't open. Clients
 *  tagged "owed BS" (client_links.bs_enabled === false) have no balance sheet
 *  behind the portal tab, so the email must not mention one.
 */
const cap: any[] = [];
(globalThis as any).fetch = async (_u: string, i: any) => { cap.push(JSON.parse(i.body)); return { ok: true, json: async () => ({ id: "x" }) } as any; };
process.env.RESEND_API_KEY = "k";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }

async function main() {
  const { sendMonthEndEmail } = await import("../lib/month-end/email");
  const base = {
    clientName: "Thompson Painting Ltd.", recipientEmail: "d@t.ca", recipientFirstName: "Dave",
    period: { label: "June 2026" } as any,
    portalUrl: "https://snap.ironbooks.com/portal/statements",
  };

  await sendMonthEndEmail({ ...base, balanceSheetAvailable: true });
  await sendMonthEndEmail({ ...base, balanceSheetAvailable: false });
  await sendMonthEndEmail({ ...base }); // flag omitted entirely
  const [withBs, owedBs, unset] = cap;

  ok("BS available → balance sheet listed in html", withBs.html.includes("Balance sheet"));
  ok("BS available → balance sheet listed in text", withBs.text.includes("Balance sheet"));

  ok("owed BS → NO balance sheet in html", !owedBs.html.includes("Balance sheet"));
  ok("owed BS → NO balance sheet in text", !owedBs.text.includes("Balance sheet"));
  ok("owed BS → no stray 'owns and owes' phrasing", !owedBs.html.includes("owns and"));

  // Under-promising is the safe direction: an un-taught caller omits the line
  // rather than promising a statement that isn't there.
  ok("flag omitted → treated as unavailable (html)", !unset.html.includes("Balance sheet"));
  ok("flag omitted → treated as unavailable (text)", !unset.text.includes("Balance sheet"));

  // Everything else must survive the gate.
  for (const [label, m] of [["withBs", withBs], ["owedBs", owedBs]] as const) {
    ok(`${label}: P&L is always listed`, m.html.includes("Profit and loss for June 2026"));
    ok(`${label}: summary is always listed`, m.html.includes("A summary of what changed"));
    ok(`${label}: subject names the period`, m.subject === "Dave, your June 2026 statements are ready");
    ok(`${label}: CTA points at the portal`, m.html.includes(base.portalUrl));
    ok(`${label}: no unresolved template literal`, !m.html.includes("${"));
    ok(`${label}: no remote images`, !/<img/i.test(m.html));
    ok(`${label}: preheader set`, m.html.includes("max-height:0"));
  }

  // ── Notice to Reader teaser (migration 156) ──────────────────────────────
  // One line, never the notice's content, no figures; absent when no notice.
  await sendMonthEndEmail({ ...base, includesNotice: true });
  await sendMonthEndEmail({ ...base });
  const [withNotice, noNotice] = cap.slice(-2);
  ok("teaser present when includesNotice (html)", withNotice.html.includes("Notice to Reader"));
  ok("teaser present when includesNotice (text)", withNotice.text.includes("Notice to Reader"));
  ok("teaser carries no figures", !/\$\d/.test(withNotice.text));
  ok("teaser points at the portal, not inline content", /read and reply/.test(withNotice.text));
  ok("no teaser by default (html)", !noNotice.html.includes("Notice to Reader"));
  ok("no teaser by default (text)", !noNotice.text.includes("Notice to Reader"));

  // No freshness claims — the old body said "closed and reconciled".
  for (const claim of ["closed and reconciled", "up to date", "up-to-date", "fully reconciled", "all caught up"]) {
    ok(`no freshness claim "${claim}"`,
      !withBs.html.toLowerCase().includes(claim) && !withBs.text.toLowerCase().includes(claim));
  }

  // The BS-gated version must not read as if something is missing — no dangling
  // "and" or empty bullet left behind by the conditional.
  ok("owed-BS body has no empty tick row", !/>&#10003;<\/div>\s*<\/td>\s*<td[^>]*>\s*<div[^>]*><\/div>/.test(owedBs.html));

  console.log(`\nmonth-end-email: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
