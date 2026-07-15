// Tests for money-movement detection + auto-route.
// Run: npx tsx scripts/test-transfer-detection.ts
import { classifyMoneyMovement, matchAccountByName, type BsAccount } from "@/lib/transfer-detection";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const cc = (n: string, id = n): BsAccount => ({ id, name: n });
const accounts = {
  creditCard: [cc("PC Financial Mastercard", "cc1"), cc("Canadian Tire Card", "cc2")],
  bank: [cc("RBC Chequing", "bk1"), cc("PC Financial Chequing", "bk2")],
  liability: [cc("Business Loan – RBC", "ln1")],
};

// ── Confident CC payment: names one card exactly → auto-route ──
const m1 = classifyMoneyMovement("INTERAC PURCHASE - PC FINANCIAL MASTERCARD PAYMENT", accounts);
ok(m1?.kind === "cc_payment", "PC Financial Mastercard payment → cc_payment");
ok(m1?.confident === true, "named-card payment is confident");
ok(m1?.target?.id === "cc1", "routed to the PC Financial Mastercard account");

// ── Generic CC payment, TWO cards, none named → park, no target ──
const m2 = classifyMoneyMovement("MASTERCARD PAYMENT THANK YOU", accounts);
ok(m2?.kind === "cc_payment", "generic mastercard payment → cc_payment");
ok(m2?.confident === false, "ambiguous card payment is not confident");
ok(m2?.target === null, "two cards + none named → no auto target (park)");

// ── Generic CC payment, ONE card on file → suggest it, still park ──
const oneCard = { creditCard: [cc("Visa", "v1")], bank: [], liability: [] };
const m3 = classifyMoneyMovement("VISA PAYMENT", oneCard);
ok(m3?.kind === "cc_payment" && m3?.confident === false, "one-card generic payment parks");
ok(m3?.target?.id === "v1", "one card on file → suggested as destination");

// ── A card PURCHASE (no payment hint) is NOT flagged as a payment ──
const m4 = classifyMoneyMovement("SHELL OIL 4821", accounts);
ok(m4 === null, "an ordinary fuel purchase is not money-movement");
const m4b = classifyMoneyMovement("HOME DEPOT #2811", accounts);
ok(m4b === null, "an ordinary store purchase is not money-movement");

// ── Loan payment: named liability → park (principal/interest split) ──
const m5 = classifyMoneyMovement("LOAN PAYMENT BUSINESS LOAN – RBC", accounts);
ok(m5?.kind === "loan_payment", "loan payment detected");
ok(m5?.confident === false, "loan payment is never auto (split)");
ok(m5?.target?.id === "ln1", "loan payment suggests the liability account");

// ── Loan wording, no named account → park, no target ──
const m6 = classifyMoneyMovement("LINE OF CREDIT PAYMENT", accounts);
ok(m6?.kind === "loan_payment" && m6?.target === null, "generic LOC payment parks with no target");

// ── Generic transfer → park; names a bank → suggest it ──
const m7 = classifyMoneyMovement("ONLINE TRANSFER TO RBC CHEQUING", accounts);
ok(m7?.kind === "transfer", "online transfer detected");
ok(m7?.confident === false, "transfer never confident (other side unknown)");
ok(m7?.target?.id === "bk1", "transfer naming a bank suggests it");

const m8 = classifyMoneyMovement("TRANSFER TO SAVINGS", accounts);
ok(m8?.kind === "transfer" && m8?.target === null, "transfer with no named account → no target");

// ── matchAccountByName: single vs ambiguous ──
ok(matchAccountByName("pc financial mastercard pmt", accounts.creditCard)?.id === "cc1", "single name match resolves");
ok(matchAccountByName("nothing here", accounts.creditCard) === null, "no match → null");

// ── Owner-draw / payroll stay OUT of this classifier (handled elsewhere) ──
const m9 = classifyMoneyMovement("GUSTO PAYROLL", accounts);
ok(m9 === null, "payroll is not money-movement here (separate hard-block)");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
