// Validate the P&L category classifier against real client account names.
// Run: npx tsx scripts/test-pl-categories.ts
import { categorizeExpenseLine } from "@/lib/pl-categories";

let pass = 0, fail = 0;
const eq = (label: string, isCogs: boolean, expectKey: string) => {
  const got = categorizeExpenseLine(label, isCogs).key;
  if (got === expectKey) pass++;
  else { fail++; console.log(`  FAIL: "${label}" (cogs=${isCogs}) → ${got}, expected ${expectKey}`); }
};

// ── Blessent's real sprawl should collapse to single categories ──
// Marketing: three separate accounts → one "marketing"
eq("Marketing", false, "marketing");
eq("Marketing Tools", false, "marketing");
eq("Online Advertising – Google Ads / Social Media Marketing", false, "marketing");

// Office & Admin: software, bank charges, office → "office_admin"
eq("Software Subscriptions", false, "office_admin");
eq("Office expenses", false, "office_admin");
eq("Office Supplies", false, "office_admin");
eq("Bank Charges", false, "office_admin");

// Insurance both variants
eq("Insurance", false, "insurance");
eq("General Liability Insurance", false, "insurance");

// Professional services
eq("Accounting & Bookkeeping", false, "professional");

// Payroll / owner / education / vehicle / meals
eq("Admin Team Salaries", false, "payroll");
eq("Owner draws", false, "owner_pay");
eq("Continuing Education / Professional Development", false, "education");
eq("Vehicle Repairs – Admin/Sales", false, "vehicle");
eq("Fuel – Admin & Sales Vehicles", false, "vehicle");
eq("Meals (50% deductible)", false, "travel_meals");
eq("Utilities", false, "rent_utilities");
eq("Taxes paid", false, "taxes_licenses");

// ── COGS side: supplies sprawl → one "cogs_materials" ──
eq("Job Supplies", true, "cogs_materials");
eq("Job Supplies & Materials", true, "cogs_materials");
eq("Paint & Materials", true, "cogs_materials");
eq("Subcontractors", true, "cogs_subs");
eq("Subcontractors – Painting", true, "cogs_subs");
eq("Permit Fees", true, "cogs_other");

// ── Fallbacks ──
eq("Some Weird Account", false, "other_operating");
eq("Random Job Thing", true, "cogs_other");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
