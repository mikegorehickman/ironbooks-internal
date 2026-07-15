/**
 * Detect money-movement that must NOT hit the P&L: credit-card payments,
 * loan payments, and inter-account transfers. These are balance-sheet moves
 * (they change what you owe / where cash sits), not expenses or revenue —
 * booking them to a P&L account corrupts the statements.
 *
 * Mike, 2026-07-15 (Dominion Painters bank feed): "transaction matching,
 * payments, transfers — so that transfers and payments don't get categorized
 * as expenses or revenue." Decision: auto-route to the correct balance-sheet
 * account WHERE CONFIDENT, park the ambiguous ones for a quick review.
 *
 * "Confident" = the transaction text names exactly one of the client's own
 * balance-sheet accounts (e.g. a "PC Financial Mastercard" payment when the
 * client has a Credit Card account by that name). That single unambiguous
 * destination is safe to auto-apply. Everything else (a bare "MASTERCARD
 * PAYMENT" with two cards, a "TRANSFER TO CHECKING", any loan payment —
 * which splits principal/interest) is parked with a suggested destination.
 *
 * Shared by the one-time reclass discover pre-pass and the daily-recon
 * pre-router so both behave identically. Pure + unit-tested.
 */
import { normalizeAccountName } from "@/lib/account-name";

export interface BsAccount {
  id: string;
  name: string;
}

export type MoneyMovementKind = "cc_payment" | "loan_payment" | "transfer";

export interface MoneyMovement {
  kind: MoneyMovementKind;
  /** The balance-sheet account to route to, when we could name one. */
  target: BsAccount | null;
  /** True only when the destination is unambiguous → safe to auto-apply.
   *  Loan payments are NEVER confident (principal/interest split needs a JE);
   *  transfers are never confident (the other side isn't in the text). */
  confident: boolean;
  reasoning: string;
}

// Credit-card signals. A bare issuer word ("mastercard") is weak on its own
// (could be a merchant), so the generic path additionally requires a payment
// hint; the strong path is a direct match to a CC account's own name.
const CC_TOKENS = /\b(master\s?card|visa|amex|american\s+express|discover\s+card|credit\s+card|cc\s+pay(ment|mt)?|card\s+pay(ment|mt)?)\b/i;
const CC_PAYMENT_HINT = /\b(pay(ment|mt)?|autopay|auto\s?pay|thank\s?you|bill\s?pay|pre-?auth(orized)?)\b/i;
const LOAN_TOKENS = /\b(loan|line\s+of\s+credit|\bloc\b|term\s+loan|instal?lment|financ(e|ing))\b/i;
// Generic inter-account transfer wording (mirrors the discover route's prior
// isBankTransfer). Kept here so both call sites share one definition.
const TRANSFER_TOKENS =
  /\b(online\s+transfer|funds?\s+transfer|internal\s+transfer|wire\s+transfer|ach\s+transfer|transfer\s+(to|from)|(xfer|tfr)\s+(to|from))\b/i;

// E-transfer plumbing words — everything left after stripping these (and
// numbers) is a counterparty name.
const ETRANSFER_BOILERPLATE = new Set([
  "e", "etransfer", "transfer", "tfr", "etfr", "emt", "interac", "online",
  "request", "requested", "fulfilled", "sent", "send", "received", "receive",
  "deposit", "account", "acct", "to", "from", "ref", "id", "incoming",
  "outgoing", "autodeposit", "auto", "pending", "unknown", "vendor", "of",
]);

/**
 * A NAMELESS e-transfer: e-transfer wording with no identifiable counterparty
 * once the boilerplate is stripped (e.g. "e-Transfer Request Fulfilled",
 * "Online Transfer to Deposit Account", vendor "Unknown"). Mike, 2026-07-15:
 * "e-transfers without names should be uncategorized / ask client." Named
 * e-transfers ("KEVIN CASSON…" → owner draw, "Sherwin Williams…" → supplies)
 * return false so the owner-detection / KB / AI paths still handle them.
 * Excludes bare "INTERAC PURCHASE/RETAIL" (debit-card purchases, not
 * e-transfers).
 */
export function isNamelessETransfer(blob: string): boolean {
  const lower = (blob || "").toLowerCase();
  const hasETransfer =
    /e[\s\-]?transfer/.test(lower) || /\be[\s\-]?tfr\b/.test(lower) || /\bemt\b/.test(lower);
  if (!hasETransfer) return false;
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const hasName = tokens.some(
    (t) => /^[a-z]/.test(t) && t.length >= 3 && !ETRANSFER_BOILERPLATE.has(t)
  );
  return !hasName;
}

const normText = (s: string) =>
  normalizeAccountName(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Does the transaction text contain exactly one of these accounts' names?
 * Returns that account, or null if zero or more than one match (ambiguous).
 * Requires a reasonably distinctive account name (≥5 normalized chars) so a
 * short generic name doesn't over-match a merchant string.
 */
export function matchAccountByName(blob: string, accounts: BsAccount[]): BsAccount | null {
  const b = normText(blob);
  if (!b) return null;
  const seen = new Set<string>();
  const hits: BsAccount[] = [];
  for (const a of accounts) {
    const n = normText(a.name);
    if (n.length < 5) continue;
    if (b.includes(n) && !seen.has(a.id)) {
      seen.add(a.id);
      hits.push(a);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Classify a money-out transaction as CC payment / loan payment / transfer,
 * and resolve the balance-sheet destination when possible.
 *
 * Order matters: a "TRANSFER TO MASTERCARD" is a CC payment, not a generic
 * transfer, so CC is checked first.
 */
export function classifyMoneyMovement(
  blob: string,
  accounts: {
    creditCard: BsAccount[];
    bank: BsAccount[];
    liability: BsAccount[];
  }
): MoneyMovement | null {
  const text = blob || "";

  // 1) Named CC account in the text → confident CC payment.
  const ccByName = matchAccountByName(text, accounts.creditCard);
  if (ccByName) {
    return {
      kind: "cc_payment",
      target: ccByName,
      confident: true,
      reasoning: `Payment to the client's "${ccByName.name}" credit card — a balance-sheet transfer that pays down the card, not an expense. Auto-routed to that account.`,
    };
  }

  // 2) Named loan/liability account in the text → loan payment (park; split).
  const loanByName = matchAccountByName(text, accounts.liability);
  if (loanByName && (LOAN_TOKENS.test(text) || TRANSFER_TOKENS.test(text) || CC_PAYMENT_HINT.test(text))) {
    return {
      kind: "loan_payment",
      target: loanByName,
      confident: false,
      reasoning: `Looks like a payment against "${loanByName.name}". Loan payments split into principal (this liability) and interest (an expense) — confirm the split before posting; do not book the whole amount as an expense.`,
    };
  }

  // 3) Generic CC-payment wording.
  if (CC_TOKENS.test(text) && CC_PAYMENT_HINT.test(text)) {
    // Exactly one card on the client → suggest it (still park to confirm).
    const onlyCard = accounts.creditCard.length === 1 ? accounts.creditCard[0] : null;
    return {
      kind: "cc_payment",
      target: onlyCard,
      confident: false,
      reasoning: onlyCard
        ? `Looks like a credit-card payment. The client has one card ("${onlyCard.name}") — suggested as the destination; confirm it's a payment (balance-sheet), not a card purchase, before posting.`
        : `Looks like a credit-card payment (balance-sheet transfer, not an expense). Pick which card it paid down before posting.`,
    };
  }

  // 4) Loan wording without a named account.
  if (LOAN_TOKENS.test(text)) {
    return {
      kind: "loan_payment",
      target: null,
      confident: false,
      reasoning: `Looks like a loan / line-of-credit payment. These split into principal (a liability) and interest (an expense) — confirm the split before posting; do not book it as a plain expense.`,
    };
  }

  // 5) Generic inter-account transfer.
  if (TRANSFER_TOKENS.test(text)) {
    // If the text happens to name one of the client's bank accounts, suggest it.
    const bankByName = matchAccountByName(text, accounts.bank);
    return {
      kind: "transfer",
      target: bankByName,
      confident: false,
      reasoning: bankByName
        ? `Detected as a transfer involving "${bankByName.name}". Transfers move money between the client's own accounts — confirm the other side before posting; never book as an expense or revenue.`
        : `Detected as a bank-to-bank transfer. Confirm which account it moved to/from before categorizing — never book as an expense or revenue.`,
    };
  }

  return null;
}
