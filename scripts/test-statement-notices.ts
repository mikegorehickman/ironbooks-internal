/** Unit tests for lib/statement-notices.ts — the Notice to Reader pure core.
 *  Run: npx tsx scripts/test-statement-notices.ts
 */
import {
  DEFAULT_BOILERPLATE,
  FORBIDDEN_ASSURANCE_PHRASES,
  assuranceProblems,
  noticePeriodLabel,
  parseRunPeriod,
  toRunPeriod,
  isAcked,
  hasViewedCurrent,
  receiptSummary,
  noticeTeaserLine,
  buildNoticeDraftPrompt,
} from "../lib/statement-notices";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

// ── 1. Boilerplate compliance ───────────────────────────────────────────────
// "Notice to Reader" is a regulated CPA term (superseded by CSRS 4200). The
// boilerplate must DISCLAIM assurance — and must never claim it. Note the
// disclaimer legitimately CONTAINS the words "audited"/"reviewed" (negated), so
// the guard bans affirmative PHRASES, not words.
console.log("boilerplate compliance");
{
  const b = DEFAULT_BOILERPLATE("Test Painting Co", "July 2026");
  ok("names the client", b.includes("Test Painting Co"));
  ok("names the period", b.includes("July 2026"));
  ok("disclaims audit/review", /not been audited or reviewed/i.test(b));
  ok("disclaims assurance explicitly", /no assurance/i.test(b));
  eq("no affirmative assurance phrases", assuranceProblems(b).length, 0);
  ok("mentions the reply affordance", /reply/i.test(b));
}
{
  // MANDATORY-NOTICE guard (Mike 2026-08-04): the send route substitutes this
  // text whenever a caller supplies none (the board's mark_complete), and the
  // backfill files it for closes that never had a compose step. An empty or
  // assurance-claiming return would silently defeat "no statements without a
  // notice", so degenerate inputs must still yield a compliant letter.
  for (const [name, args] of [
    ["empty client name", ["", "July 2026"]],
    ["empty period label", ["Test Painting Co", ""]],
    ["both empty", ["", ""]],
    ["punctuation-only name", ["   ", "—"]],
  ] as Array<[string, [string, string]]>) {
    const b = DEFAULT_BOILERPLATE(args[0], args[1]);
    ok(`fallback non-empty — ${name}`, b.trim().length > 100);
    ok(`fallback still disclaims — ${name}`, /not been audited or reviewed/i.test(b) && /no assurance/i.test(b));
    eq(`fallback claims nothing — ${name}`, assuranceProblems(b).length, 0);
  }
}
{
  ok("catches 'we have audited'", assuranceProblems("We have audited these statements").length > 0);
  ok("catches 'in our opinion'", assuranceProblems("In our opinion the statements present fairly").length >= 2);
  ok("clean text passes", assuranceProblems("These are management-use statements.").length === 0);
  ok("phrase list is non-empty", FORBIDDEN_ASSURANCE_PHRASES.length >= 5);
}

// ── 2-4. Draft prompt assembly ──────────────────────────────────────────────
console.log("draft prompt");
const base = { clientName: "Test Painting Co", periodLabel: "July 2026", redFlags: [], concerns: null, openQuestions: [], unansweredClientMessages: [] };
{
  // Clean month → states nothing found, requests nothing.
  const p = buildNoticeDraftPrompt(base);
  ok("clean run says nothing was flagged", /Nothing was flagged this month/.test(p));
  ok("clean run instructs to request nothing", /request nothing/i.test(p));
  ok("names client and period", p.includes("Test Painting Co") && p.includes("July 2026"));
  ok("forbids assurance language in output", /never "audited"/.test(p));
}
{
  // Loaded month → every input lands, in the right framing.
  const p = buildNoticeDraftPrompt({
    ...base,
    redFlags: ["Duplicate payroll suspected in Direct Labor", "COGS at 71% of revenue"],
    concerns: "Client keeps paying subs from personal account",
    openQuestions: ["Was the $5,000 e-transfer on Jul 14 a draw?"],
    unansweredClientMessages: ["Question about P&L line — Fuel"],
  });
  ok("red flags enumerated", p.includes("Duplicate payroll suspected in Direct Labor"));
  ok("concerns present but marked internal (rephrase)", /rephrase professionally, do not quote/.test(p) && p.includes("personal account"));
  ok("open questions carried (don't re-ask framing separate)", p.includes("$5,000 e-transfer"));
  ok("unanswered messages acknowledged not re-asked", /acknowledge, don't re-ask/.test(p) && p.includes("Fuel"));
  ok("clean-month text absent", !/Nothing was flagged this month/.test(p));
}
{
  // Degenerate inputs: nulls/empties/oversize → no throw, clamped. Distinct
  // fillers per field so one field's (correct) 2000-char clamp can't mask
  // another's missing 200-char clamp.
  const p = buildNoticeDraftPrompt({
    ...base,
    redFlags: ["x".repeat(5000), "", null as any],
    concerns: "y".repeat(5000),
    openQuestions: new Array(30).fill("q?"),
    unansweredClientMessages: [],
  });
  ok("oversize flag clamped to ~200", !p.includes("x".repeat(300)));
  ok("oversize concerns clamped to ~2000", !p.includes("y".repeat(2100)) && p.includes("y".repeat(1000)));
  ok("question list capped at 12", (p.match(/\n- q\?/g) || []).length <= 12);
}

// ── 5. Ack validity ─────────────────────────────────────────────────────────
console.log("isAcked / hasViewedCurrent");
const notice = { sent_at: "2026-08-01T10:00:00.000Z" };
eq("no receipt → unacked", isAcked(null, notice), false);
eq("ack BEFORE sent_at (stale, post-resend) → unacked", isAcked({ acknowledged_at: "2026-07-30T10:00:00.000Z" }, notice), false);
eq("ack after sent_at → acked", isAcked({ acknowledged_at: "2026-08-02T10:00:00.000Z" }, notice), true);
eq("ack exactly at sent_at → acked", isAcked({ acknowledged_at: "2026-08-01T10:00:00.000Z" }, notice), true);
eq("viewed-only is not acked", isAcked({ first_viewed_at: "2026-08-02T10:00:00.000Z", acknowledged_at: null }, notice), false);
eq("viewed-only IS viewed", hasViewedCurrent({ first_viewed_at: "2026-08-02T10:00:00.000Z" }, notice), true);
eq("stale view (pre-resend) not viewed-current", hasViewedCurrent({ first_viewed_at: "2026-07-30T10:00:00.000Z" }, notice), false);

// ── 6. Period label ─────────────────────────────────────────────────────────
console.log("period helpers");
eq("Feb label", noticePeriodLabel(2026, 2), "February 2026");
eq("Dec label", noticePeriodLabel(2026, 12), "December 2026");
{
  let threw = false;
  try { noticePeriodLabel(2026, 13); } catch { threw = true; }
  ok("month 13 rejected", threw);
}
// Round-trip with monthly_rec_runs.period.
eq("parse '2026-07'", JSON.stringify(parseRunPeriod("2026-07")), JSON.stringify({ year: 2026, month: 7 }));
eq("round-trip", toRunPeriod(2026, 7), "2026-07");
eq("single-digit month pads", toRunPeriod(2026, 2), "2026-02");

// ── 7. Teaser ───────────────────────────────────────────────────────────────
console.log("teaser");
{
  const t = noticeTeaserLine();
  ok("no dollar figure ever", !/\$\d/.test(t));
  ok("points at the portal", /portal/i.test(t));
  ok("names the artifact", /notice to reader/i.test(t));
}

// ── 8. Receipt rollup ───────────────────────────────────────────────────────
console.log("receiptSummary");
const NOW = Date.parse("2026-08-05T10:00:00.000Z");
{
  const s = receiptSummary([], 0, notice, NOW);
  eq("zero portal users → explicit state", s.label, "Notice sent — no portal logins yet for this client");
  eq("no division error", s.acked, 0);
}
{
  const s = receiptSummary([], 2, notice, NOW);
  ok("unviewed shows aging days", /unviewed for 4 days/.test(s.label));
}
{
  const s = receiptSummary(
    [
      { first_viewed_at: "2026-08-02T10:00:00.000Z", acknowledged_at: "2026-08-02T10:05:00.000Z" },
      { first_viewed_at: "2026-08-03T10:00:00.000Z", acknowledged_at: null },
    ],
    2, notice, NOW
  );
  eq("N of M math", s.label, "Notice acknowledged by 1 of 2 portal users");
  eq("viewed count", s.viewed, 2);
  eq("aging null once viewed", s.unviewedForDays, null);
}
{
  // Post-resend: old acks don't count toward N.
  const resent = { sent_at: "2026-08-04T10:00:00.000Z" };
  const s = receiptSummary(
    [{ first_viewed_at: "2026-08-02T10:00:00.000Z", acknowledged_at: "2026-08-02T10:05:00.000Z" }],
    1, resent, NOW
  );
  eq("stale ack not counted after resend", s.acked, 0);
  ok("resent notice reads unviewed again", /unviewed/.test(s.label));
}

console.log(`\nstatement-notices: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
