// Tests for bookkeeper-QOL KB changes: gas-station amount bands + ad descriptors.
// Run: npx tsx scripts/test-vendor-kb-qol.ts
import { lookupVendor } from "@/lib/vendor-knowledge";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const acct = (v: string, amt: number) => lookupVendor(v, "", amt, "painters")?.account ?? null;
const conf = (v: string, amt: number) => lookupVendor(v, "", amt, "painters")?.confidence ?? null;

// ── Gas-station amount bands ──
ok(acct("SHELL 4529 SASKATOON", 6.5) === "Meals (50% deductible)", "Shell $6.50 → Meals");
ok(conf("SHELL 4529 SASKATOON", 6.5)! < 0.95, "small gas purchase stays below auto-execute floor");
ok(acct("SHELL 4529 SASKATOON", 80) === "Fuel – Overhead", "Shell $80 → Fuel");
ok(acct("ESSO CIRCLE DR", 12) === "Meals (50% deductible)", "Esso $12 → Meals");
ok(acct("ESSO CIRCLE DR", 65) === "Fuel – Overhead", "Esso $65 → Fuel");
ok(acct("CIRCLE K #2231", 4) === "Meals (50% deductible)", "Circle K $4 → Meals");
ok(acct("7-ELEVEN 33099", 44) === "Fuel – Overhead", "7-Eleven $44 → Fuel");
// pay-at-pump / cardlock exclusions: small amount is still fuel
ok(acct("COSTCO GAS W441", 12) === "Fuel – Overhead", "Costco Gas $12 stays Fuel (pay-at-pump only)");
ok(acct("PETRO-PASS SASKATOON", 9) === "Fuel – Overhead", "Petro-Pass $9 stays Fuel (cardlock)");
ok(acct("HUGHES PETROLEUM LTD", 8) === "Fuel – Overhead", "Hughes $8 stays Fuel (commercial)");
// existing tiny-fee rule still wins for fees
ok(acct("E-TRANSFER FEE", 1.5) === "Bank Charges", "e-transfer $1.50 still Bank Charges");

// ── Ad descriptors ──
ok(acct("GOOGLE*ADS4739 CC", 250) === "Online Advertising – Google Ads / Social Media Marketing", "GOOGLE*ADS4739 → Advertising");
ok(acct("GOOGLEADS7301", 512) === "Online Advertising – Google Ads / Social Media Marketing", "GOOGLEADS → Advertising");
ok(acct("FACEBK *X2A7B9", 340) === "Online Advertising – Google Ads / Social Media Marketing", "FACEBK * → Advertising");
ok(conf("FACEBK *X2A7B9", 340) === 0.97, "FACEBK descriptor is high confidence");
ok(acct("FB *ADVERTISING", 120) === "Online Advertising – Google Ads / Social Media Marketing", "FB * → Advertising");
// software disambiguation intact
ok(acct("GOOGLE*GSUITE_paintco", 18) === "Software Subscriptions", "GOOGLE*GSUITE → Software");
ok(acct("GOOGLE WORKSPACE", 22) === "Software Subscriptions", "Google Workspace → Software");
// bare-vendor fallbacks: moderate confidence, queue not auto
ok(acct("GOOGLE", 300) === "Online Advertising – Google Ads / Social Media Marketing", "bare GOOGLE → Advertising fallback");
ok(conf("GOOGLE", 300)! < 0.95, "bare GOOGLE stays below auto floor");
ok(acct("FACEBOOK", 150) === "Online Advertising – Google Ads / Social Media Marketing", "bare FACEBOOK → Advertising fallback");
ok(acct("GOOGLE *YOUTUBE", 14) !== "Online Advertising – Google Ads / Social Media Marketing", "GOOGLE *YOUTUBE excluded from ads fallback");
ok(acct("FACEBOOK MARKETPLACE", 60) !== "Online Advertising – Google Ads / Social Media Marketing", "FB Marketplace excluded from ads fallback");
ok(acct("META QUEST STORE", 500) !== "Online Advertising – Google Ads / Social Media Marketing", "Meta Quest excluded from ads fallback");

// ── Sanity: nothing above broke ──
ok(acct("SHERWIN WILLIAMS 703581", 214) === "Job Supplies & Materials", "Sherwin-Williams intact");
ok(acct("TIM HORTONS #3320", 8) === "Meals (50% deductible)", "Tim Hortons intact");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
