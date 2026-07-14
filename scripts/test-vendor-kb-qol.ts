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
// expanded band: ALL retail gas brands, <$20 (Mike 2026-07-13)
ok(acct("QUIKTRIP #442 PHOENIX", 15) === "Meals (50% deductible)", "QuikTrip $15 → Meals");
ok(acct("QUICK TRIP", 8) === "Meals (50% deductible)", "Quick Trip $8 → Meals");
ok(acct("QUIKTRIP #442 PHOENIX", 47) === "Fuel – Overhead", "QuikTrip $47 → Fuel");
ok(acct("WAWA 8123", 18) === "Meals (50% deductible)", "Wawa $18 → Meals (band now <$20)");
ok(acct("SHEETZ 552", 19.5) === "Meals (50% deductible)", "Sheetz $19.50 → Meals");
ok(acct("CASEY'S GENERAL STORE", 12) === "Meals (50% deductible)", "Casey's $12 → Meals (pizza)");
ok(acct("MARATHON PETRO 7712", 61) === "Fuel – Overhead", "Marathon $61 → Fuel");
ok(acct("KWIK TRIP 330", 20) === "Fuel – Overhead", "$20 exactly → Fuel (band is <$20)");
// existing tiny-fee rule still wins for fees
ok(acct("E-TRANSFER FEE", 1.5) === "Bank Charges", "e-transfer $1.50 still Bank Charges");

// ── Ad descriptors ──
ok(acct("GOOGLE*ADS4739 CC", 250) === "Online Advertising - Ad Spend", "GOOGLE*ADS4739 → Advertising");
ok(acct("GOOGLEADS7301", 512) === "Online Advertising - Ad Spend", "GOOGLEADS → Advertising");
ok(acct("FACEBK *X2A7B9", 340) === "Online Advertising - Ad Spend", "FACEBK * → Advertising");
ok(conf("FACEBK *X2A7B9", 340) === 0.97, "FACEBK descriptor is high confidence");
ok(acct("FB *ADVERTISING", 120) === "Online Advertising - Ad Spend", "FB * → Advertising");
// software disambiguation intact
ok(acct("GOOGLE*GSUITE_paintco", 18) === "Software Subscriptions", "GOOGLE*GSUITE → Software");
ok(acct("GOOGLE WORKSPACE", 22) === "Software Subscriptions", "Google Workspace → Software");
// bare-vendor fallbacks: moderate confidence, queue not auto
ok(acct("GOOGLE", 300) === "Online Advertising - Ad Spend", "bare GOOGLE → Advertising fallback");
ok(conf("GOOGLE", 300)! < 0.95, "bare GOOGLE stays below auto floor");
ok(acct("FACEBOOK", 150) === "Online Advertising - Ad Spend", "bare FACEBOOK → Advertising fallback");
ok(acct("GOOGLE *YOUTUBE", 14) !== "Online Advertising - Ad Spend", "GOOGLE *YOUTUBE excluded from ads fallback");
ok(acct("FACEBOOK MARKETPLACE", 60) !== "Online Advertising - Ad Spend", "FB Marketplace excluded from ads fallback");
ok(acct("META QUEST STORE", 500) !== "Online Advertising - Ad Spend", "Meta Quest excluded from ads fallback");

// ── Reviewed-KB rebuild: recategorizations (2026-07) ──
// groceries → Meals 50% (was Employee Benefits / Job Supplies)
ok(acct("SOBEYS #1123", 40) === "Meals (50% deductible)", "Sobeys → Meals");
ok(acct("CO-OP FOOD STORE", 55) === "Meals (50% deductible)", "Co-op Food → Meals");
ok(acct("SAFEWAY #4410", 30) === "Meals (50% deductible)", "Safeway → Meals (was Job Supplies)");
ok(acct("SAVE ON FOODS", 25) === "Meals (50% deductible)", "Save-On-Foods → Meals");
// telecom → Utilities (was Software Subscriptions); hyphen-safe
ok(acct("T-MOBILE WEB PAYMENT", 90) === "Utilities", "T-Mobile → Utilities (hyphen)");
ok(acct("COMCAST XFINITY", 120) === "Utilities", "Comcast → Utilities");
ok(acct("FIDO MOBILE", 65) === "Utilities", "Fido → Utilities");
ok(acct("XFINITY MOBILE", 70) === "Utilities", "Xfinity Mobile → Utilities");
// drugstores → Office Supplies (was Job Supplies)
ok(acct("CVS/PHARMACY 8842", 18) === "Office Supplies", "CVS → Office Supplies");
ok(acct("SHOPPERS DRUG MART", 22) === "Office Supplies", "Shoppers → Office Supplies");
// field-service software → Software Subscriptions (was Marketing Tools)
ok(acct("JOBBER GETJOBBER.COM", 99) === "Software Subscriptions", "Jobber → Software");
ok(acct("BUILDERTREND", 199) === "Software Subscriptions", "BuilderTrend → Software");
ok(acct("SERVICETITAN INC", 350) === "Software Subscriptions", "ServiceTitan → Software");
// EZ Pass → Tolls; PlayStation → Owner's Draw
ok(acct("EZ PASS REBILL", 40) === "Tolls", "EZ Pass → Tolls (was Permit Fees)");
ok(acct("PLAYSTATION NETWORK", 17) === "Owner's Draw", "PlayStation → Owner's Draw (was Software)");
// split bundles resolve to their own vendors, same account
ok(acct("SLACK T12345", 12) === "Software Subscriptions", "Slack → Software (split)");
ok(acct("FEDEX 774120", 45) === "Postage & Delivery", "FedEx → Postage (split)");
ok(acct("PUROLATOR", 30) === "Postage & Delivery", "Purolator → Postage (split)");
ok(lookupVendor("OPENAI CHATGPT SUBSCR", "", 20, "painters")?.vendor === "OpenAI", "OpenAI split names correctly");
// bank fees: explicit "fee" wording is Bank Charges at ANY amount; bare e-transfer is not
ok(acct("INTERAC E-TRANSFER FEE", 50) === "Bank Charges", "e-transfer FEE at $50 → Bank Charges (no amount gate)");
ok(acct("SEND E-TFR FEE", 500) === "Bank Charges", "e-tfr FEE at $500 → Bank Charges");
ok(acct("E-TRANSFER TO JOHN", 500) !== "Bank Charges", "bare $500 e-transfer is NOT a bank fee");

// ── Substring-collision guards (Wawanessa bug, 2026-07-13) ──
// Bare vendor words must match as WORDS, never inside other words.
ok(acct("WAWANESSA INSURANCE", 87) === "Insurance – Other", "WawaNESSA Insurance → Insurance (NOT Wawa fuel)");
ok(acct("WAWANESA INSURANCE", 87) === "Insurance – Other", "Wawanesa (one s) → Insurance");
ok(acct("WAWA 8123", 45) === "Fuel – Overhead", "real Wawa store still → Fuel");
ok(acct("HEADPHONES ADAPTER USB", 25) !== "Payroll Expenses", "hEADPhones does not match ADP");
ok(acct("CANVAS PRINTING CO", 60) !== "Software Subscriptions", "CANVAs does not match Canva");
ok(acct("TARGETED MARKETING LLC", 200) !== "Office Supplies", "TARGETed does not match Target");

// ── Sanity: nothing above broke ──
ok(acct("SHERWIN WILLIAMS 703581", 214) === "Job Supplies & Materials", "Sherwin-Williams intact (painters)");
ok(lookupVendor("SHERWIN WILLIAMS 703581", "", 214, "plumbers")?.account == null, "Sherwin painter-scoped: no match for non-painter industry");
ok(acct("TIM HORTONS #3320", 8) === "Meals (50% deductible)", "Tim Hortons intact");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
