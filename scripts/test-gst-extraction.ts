/** Unit tests for lib/gst-extraction.ts — the GST/HST/PST planner.
 *  Run: npx tsx scripts/test-gst-extraction.ts
 *
 *  Covers the split math (totals must never move), province/period rules, and
 *  the CRA-based purchase-PST rules that decide the recoverable ITC base.
 */
import {
  ratesFor,
  splitIncome,
  splitExpense,
  purchasePstRate,
  classifyAccountKind,
  normalizeAccountKey,
  taxAccountNamesFor,
  resolveExtractionWindow,
} from "../lib/gst-extraction";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const near = (a: number, b: number, eps = 0.005) => Math.abs(a - b) < eps;

// ── Province + period rates ────────────────────────────────────────────────
const on = ratesFor("ON", "2026-05-15")!;
const bc = ratesFor("BC", "2026-05-15")!;
const sk = ratesFor("SK", "2026-05-15")!;
const mb = ratesFor("MB", "2026-05-15")!;
const ab = ratesFor("AB", "2026-05-15")!;
const qc = ratesFor("QC", "2026-05-15")!;

ok("ON = 13% HST, no PST", near(on.gstHst, 0.13) && on.pst === 0);
ok("BC = 5% GST + 7% PST", near(bc.gstHst, 0.05) && near(bc.pst, 0.07));
ok("SK = 5% GST + 6% PST", near(sk.gstHst, 0.05) && near(sk.pst, 0.06));
ok("AB = 5% GST only", near(ab.gstHst, 0.05) && ab.pst === 0);
ok("QC folds QST into the federal-equivalent rate", near(qc.gstHst, 0.14975) && qc.isQuebec);
// NS is period-aware: 15% before 2025-04-01, 14% after.
ok("NS 15% pre-2025-04-01", near(ratesFor("NS", "2025-03-31")!.gstHst, 0.15));
ok("NS 14% post-2025-04-01", near(ratesFor("NS", "2025-04-01")!.gstHst, 0.14));
ok("unknown province → null", ratesFor("XX", "2026-05-15") === null);

// ── Account naming (QST for Quebec) ────────────────────────────────────────
ok("QC accounts named QST", taxAccountNamesFor("QC").payable === "GST/QST Payable");
ok("ON accounts named GST/HST", taxAccountNamesFor("ON").payable === "GST/HST Payable");

// ── Income split: totals must never move ──────────────────────────────────
{
  const s = splitIncome(1130, on);
  ok("ON income 1130 → 1000 + 130 HST", near(s.net, 1000) && near(s.gstHst, 130) && s.pst === 0);
  ok("ON income total preserved", near(s.net + s.gstHst + s.pst, 1130));
}
{
  // BC/MB: PST does NOT apply to painting labour on real property → GST only.
  const s = splitIncome(1050, bc);
  ok("BC income = GST only (no PST on labour)", near(s.net, 1000) && near(s.gstHst, 50) && s.pst === 0);
}
{
  // SK: PST DOES apply to construction/painting services.
  const s = splitIncome(1110, sk);
  ok("SK income splits GST and PST", near(s.net, 1000) && near(s.gstHst, 50) && near(s.pst, 60));
  ok("SK income total preserved", near(s.net + s.gstHst + s.pst, 1110));
}
{
  // Refunds/negative lines split too, and still reconcile.
  const s = splitIncome(-565, on);
  ok("negative income splits", s.gstHst < 0 && near(s.net + s.gstHst, -565));
}
ok("zero income is a no-op", splitIncome(0, on).gstHst === 0);

// ── purchasePstRate: the CRA rules (Mike 2026-07-27) ──────────────────────
ok("no-PST province → 0", purchasePstRate(on, "goods", "Materials") === 0);
ok("AB → 0", purchasePstRate(ab, "goods", "Materials") === 0);
ok("QC (QST folded, fully recoverable) → 0", purchasePstRate(qc, "goods", "Materials") === 0);
ok("kind none → 0", purchasePstRate(bc, "none", "Payroll") === 0);
// SK taxes goods AND services outright.
ok("SK goods → PST", near(purchasePstRate(sk, "goods", "Materials"), 0.06));
ok("SK services → PST", near(purchasePstRate(sk, "service", "Subcontractors"), 0.06));
// BC/MB: goods always carry PST.
ok("BC goods → PST", near(purchasePstRate(bc, "goods", "Paint and Materials"), 0.07));
ok("MB goods → RST", near(purchasePstRate(mb, "goods", "Job Supplies"), 0.07));
// BC/MB services: taxable only for tangible property / telecom.
ok("BC equipment rental → PST", near(purchasePstRate(bc, "service", "Equipment Rental"), 0.07));
ok("BC vehicle repairs → PST", near(purchasePstRate(bc, "service", "Repairs - Vehicles"), 0.07));
ok("MB tool rental → RST", near(purchasePstRate(mb, "service", "Tool Rentals"), 0.07));
ok("BC scaffolding lease → PST", near(purchasePstRate(bc, "service", "Scaffolding Lease"), 0.07));
// …and exempt for real property / professional / fuel / utilities.
ok("BC subcontract labour → exempt", purchasePstRate(bc, "service", "Subcontractors - Painting") === 0);
ok("BC premises rent → exempt", purchasePstRate(bc, "service", "Rent - Office") === 0);
ok("BC building maintenance → exempt", purchasePstRate(bc, "service", "Repairs & Maintenance - Building") === 0);
ok("BC accounting fees → exempt", purchasePstRate(bc, "service", "Accounting & Bookkeeping") === 0);
ok("BC advertising → exempt", purchasePstRate(bc, "service", "Advertising & Marketing") === 0);
ok("BC fuel → exempt (motor fuel tax instead)", purchasePstRate(bc, "service", "Fuel - Vehicles") === 0);
ok("BC utilities → exempt", purchasePstRate(bc, "service", "Utilities - Hydro") === 0);
// The exempt signal wins over a taxable keyword in the same name.
ok("exempt signal beats taxable keyword", purchasePstRate(bc, "service", "Vehicle Insurance") === 0);
ok("unknown BC service defaults exempt", purchasePstRate(bc, "service", "Miscellaneous") === 0);

// ── Expense split: only GST/HST is recoverable ────────────────────────────
{
  const s = splitExpense(1130, on, "goods", "Materials")!;
  ok("ON goods ITC = full HST", near(s.itc, 130) && near(s.net, 1000));
  ok("ON expense total preserved", near(s.net + s.itc, 1130));
}
{
  // BC goods: price embeds 5% GST + 7% PST. Only the GST is an ITC; the PST
  // stays inside the expense. 1120 gross on a 1000 base → ITC 50, net 1070.
  const s = splitExpense(1120, bc, "goods", "Paint and Materials")!;
  ok("BC goods ITC = GST portion only", near(s.itc, 50));
  ok("BC goods PST stays in the expense", near(s.net, 1070));
  ok("BC goods total preserved", near(s.net + s.itc, 1120));
}
{
  // BC subcontract labour: GST only embedded → full 5% recoverable.
  const s = splitExpense(1050, bc, "service", "Subcontractors - Painting")!;
  ok("BC subcontract ITC = full GST", near(s.itc, 50) && near(s.net, 1000));
}
{
  // BC vehicle repair: PST applies → smaller ITC than the naive 5%.
  const naive = splitExpense(1120, bc, "service", "Subcontractors")!;
  const taxed = splitExpense(1120, bc, "service", "Repairs - Vehicles")!;
  ok("PST-taxable service claims less ITC than exempt service", taxed.itc < naive.itc);
  ok("BC vehicle repair ITC = GST base only", near(taxed.itc, 50));
}
ok("kind none → no split", splitExpense(1130, on, "none", "Payroll") === null);
ok("zero expense → no split", splitExpense(0, on, "goods", "Materials") === null);

// ── Rounding sweep: totals must reconcile to the cent, every province ──────
{
  let mismatches = 0;
  const provs = [on, bc, sk, mb, ab, qc];
  for (const p of provs) {
    for (let cents = 1; cents <= 4000; cents++) {
      const gross = cents / 100;
      const i = splitIncome(gross, p);
      if (!near(i.net + i.gstHst + i.pst, gross, 0.0051)) mismatches++;
      const e = splitExpense(gross, p, "goods", "Materials");
      if (e && !near(e.net + e.itc, gross, 0.0051)) mismatches++;
    }
  }
  ok(`rounding sweep reconciles (${provs.length} provinces × 4000 amounts)`, mismatches === 0);
}

// ── Account classification (off-master fallback) ───────────────────────────
ok("payroll → none", classifyAccountKind("Payroll Expenses") === "none");
ok("meals → none (50% ITC restriction)", classifyAccountKind("Meals & Entertainment") === "none");
ok("materials → goods", classifyAccountKind("Paint and Materials") === "goods");
ok("subcontractors → service", classifyAccountKind("Subcontractors") === "service");
ok("unknown → null", classifyAccountKind("Zzz Unmapped") === null);
ok("normalizeAccountKey folds dashes/ampersands",
  normalizeAccountKey("Subcontractors – Painting") === normalizeAccountKey("subcontractors & painting".replace("&", "-")) ||
  normalizeAccountKey("Repairs & Maintenance") === "repairs and maintenance");

// ── Window resolution: YTD, or resume after last separation, max 1 year ────
const TODAY = "2026-07-27";
{
  // Nothing separated before → year to date.
  const w = resolveExtractionWindow({ today: TODAY });
  ok("no prior separation → YTD", w.start === "2026-01-01" && w.end === TODAY);
  ok("YTD reason states no earlier separation", /year to date/i.test(w.reason));
  ok("YTD is not a resume", !w.resumedFromPriorRun);
}
{
  // Separated through March → resume April 1, skipping work already done.
  const w = resolveExtractionWindow({ today: TODAY, lastSeparatedThrough: "2026-03-31" });
  ok("resumes the day after the last separation", w.start === "2026-04-01");
  ok("resume is flagged", w.resumedFromPriorRun && /2026-03-31/.test(w.reason));
}
{
  // Separated through Sept 2025 → reaching back before Jan 1 is allowed…
  const w = resolveExtractionWindow({ today: TODAY, lastSeparatedThrough: "2025-09-30" });
  ok("resume may reach before Jan 1", w.start === "2025-10-01" && !w.cappedByOneYear);
}
{
  // …but never more than a year back.
  const w = resolveExtractionWindow({ today: TODAY, lastSeparatedThrough: "2023-12-31" });
  ok("clamped to one year back", w.start === "2025-07-27" && w.cappedByOneYear);
  ok("one-year clamp is explained", /one year/i.test(w.reason));
}
{
  // Closed books win over both — a filed period must not move.
  const w = resolveExtractionWindow({
    today: TODAY, lastSeparatedThrough: "2025-09-30", closingDate: "2026-04-30",
  });
  ok("closing date floors the window", w.start === "2026-05-01" && w.cappedByClosingDate);
  ok("closing-date clamp is explained", /closing date/i.test(w.reason));
}
{
  // Closing date earlier than the natural start changes nothing.
  const w = resolveExtractionWindow({ today: TODAY, closingDate: "2025-12-31" });
  ok("closing date before YTD start is a no-op", w.start === "2026-01-01" && !w.cappedByClosingDate);
}
{
  // Already fully separated → nothing to do.
  const w = resolveExtractionWindow({ today: TODAY, lastSeparatedThrough: TODAY });
  ok("already current → nothing to analyze", w.start > w.end && /nothing to analyze/i.test(w.reason));
}
{
  // Explicit dates always win.
  const w = resolveExtractionWindow({
    today: TODAY, explicitStart: "2026-02-01", explicitEnd: "2026-02-28",
    lastSeparatedThrough: "2026-06-30", closingDate: "2026-05-31",
  });
  ok("explicit window overrides every rule", w.start === "2026-02-01" && w.end === "2026-02-28");
  ok("explicit window is labelled custom", /custom/i.test(w.reason));
}
{
  // Leap-year safety on the one-year floor.
  const w = resolveExtractionWindow({ today: "2028-02-29", lastSeparatedThrough: "2020-01-01" });
  ok("leap-day one-year floor is a valid date", /^\d{4}-\d{2}-\d{2}$/.test(w.start) && w.start === "2027-02-28" || w.start === "2027-03-01");
}

console.log(`\ngst-extraction: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
