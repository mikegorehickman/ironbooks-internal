/** Tests for PAYROLL_ACCOUNT_NAME_REGEX — which accounts the payroll
 *  double-count diagnostics are allowed to LOOK at.
 *  Run: npx tsx scripts/test-payroll-account-regex.ts
 *
 *  The failure this guards against was measured on RocketPainter Kingston
 *  (2026-07-31): the two biggest labor lines on the P&L were "Direct Field
 *  Labor – Painting" ($69K) and "Subcontractors – Painting" ($75K). Only the
 *  first matched, so /api/admin/payroll-inspect — the tool built to find
 *  double-booked labor — silently skipped the larger account, and the fleet
 *  scan reported $3,200 of duplication against a suspected ~$50K.
 */
import { PAYROLL_ACCOUNT_NAME_REGEX } from "../lib/payroll-double-entry";

let pass = 0,
  fail = 0;
const hit = (name: string) =>
  PAYROLL_ACCOUNT_NAME_REGEX.test(name) ? pass++ : (fail++, console.error(`  ✗ should MATCH: "${name}"`));
const miss = (name: string) =>
  !PAYROLL_ACCOUNT_NAME_REGEX.test(name) ? pass++ : (fail++, console.error(`  ✗ should NOT match: "${name}"`));

// ── The accounts that were already covered ─────────────────────────────────
for (const n of [
  "Wages",
  "Wages & Salaries",
  "Salaries & Payroll",
  "Payroll Expenses",
  "Direct Field Labor",
  "Direct Field Labor – Painting",
  "Job Costs - Labor",
  "Crew Pay",
  "Officer Compensation",
  "Production Wages",
]) hit(n);

// ── RocketPainter: the regression this change exists for ──────────────────
hit("Subcontractors – Painting");
hit("Subcontractors");
hit("Subcontractor Labour");
hit("Subcontracted Services");
hit("1099 Contractors");
hit("Contractor Payments");
hit("Contract Labor");

// ── Plurals and inflections — the pre-existing false negatives ────────────
//     Verified against the old regex 2026-07-31: only the exact singulars
//     "Wage", "Payroll", "Labor" and "Crew Pay" matched. Everything below was
//     silently skipped by every payroll diagnostic.
hit("Wage");
hit("Salary");
hit("Salaries");
hit("Payroll");
hit("Payrolls");
hit("Officer Comp");
hit("Crew Payments");

// ── Canadian spelling — 31 active CA clients ──────────────────────────────
hit("Direct Field Labour");
hit("Labour");
hit("Job Costs - Labour");
hit("Contract Labour");

// ── Must NOT sweep in unrelated expense accounts ─────────────────────────
//     A false positive here is cheap (one extra account inspected) but it
//     escalates a flagged suspect from warn to fail in books-verification, so
//     the boundary still matters.
for (const n of [
  "Paint & Materials",
  "Job Supplies & Materials",
  "Equipment Rental (Job-Specific)",
  "Meals (50% deductible)",
  "Office Rent",
  "Software Subscriptions",
  "Fuel – Overhead",
  "Job Disposal Fees",
  "Advertising & Marketing",
  "Direct Field Taxes",
  "Bank Charges",
  "Painting Revenue",
]) miss(n);

// "Labor" must be a whole word — an account about laboratories or elaborate
// anything is not a wage account.
miss("Laboratory Testing");
miss("Collaboration Tools");

console.log(`\npayroll account regex: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
