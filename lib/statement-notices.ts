/**
 * Notice to Reader — lib (migration 156).
 * ----------------------------------------
 * The client-facing letter a manager attaches when closing a month: standard
 * boilerplate + an AI-suggested "what we noticed / what we need from you"
 * section + a custom section. Shown to the client as a modal on every P&L open
 * until acknowledged; replies land in the team inbox and email the sender.
 *
 * CLIENT-SAFE: no supabase, no anthropic — imported by the rec-card compose
 * panel and the portal modal. Server-only pieces (AI generation, fetch
 * helpers) live in lib/statement-notices-server.ts.
 *
 * Rules encoded here (design-reviewed — don't regress):
 *   - Acked ⟺ receipt.acknowledged_at >= notice.sent_at. Re-sending bumps
 *     sent_at, which self-invalidates every stale ack without deleting receipt
 *     history. Never anchor validity to monthly_rec_runs.sent_to_client_at —
 *     reopening a month nulls that stamp.
 *   - Bodies are snapshots as sent; the DEFAULT_BOILERPLATE here is only the
 *     PRE-FILL for the compose box.
 *   - COMPLIANCE: "Notice to Reader" is a regulated CPA term in Canada
 *     (superseded by CSRS 4200 compilation reports). The boilerplate must
 *     DISCLAIM assurance ("has not been audited or reviewed"), and must never
 *     make an affirmative assurance claim ("we have audited", "in our
 *     opinion"). Fixtures enforce both directions. Final wording is Mike's.
 */

// ── Period helpers ──────────────────────────────────────────────────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "February 2026" — pure string math, no Date, so no timezone off-by-one. */
export function noticePeriodLabel(year: number, month: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`noticePeriodLabel: bad period ${year}-${month}`);
  }
  return `${MONTHS[month - 1]} ${year}`;
}

/** 'YYYY-MM' (monthly_rec_runs.period) → {year, month}. */
export function parseRunPeriod(period: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(period || "");
  if (!m) throw new Error(`parseRunPeriod: bad period "${period}" (want YYYY-MM)`);
  const year = +m[1];
  const month = +m[2];
  if (month < 1 || month > 12) throw new Error(`parseRunPeriod: bad month in "${period}"`);
  return { year, month };
}

/** {year, month} → 'YYYY-MM' — the inverse, for round-tripping with runs. */
export function toRunPeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// ── Boilerplate ─────────────────────────────────────────────────────────────

/**
 * Pre-fill for the compose box. Seeded from the P&L's long-standing disclaimer
 * (cash basis, not audited or reviewed) plus what a reader should do with the
 * statements. Editable by the sender; the sent text is snapshotted on the row.
 */
export function DEFAULT_BOILERPLATE(clientName: string, periodLabel: string): string {
  return (
    `This Notice to Reader accompanies the ${periodLabel} financial statements for ${clientName}.\n\n` +
    `These statements were compiled from your QuickBooks records on a cash basis. ` +
    `They have not been audited or reviewed, and no assurance is expressed on them — ` +
    `they are management information, prepared to help you run the business.\n\n` +
    `For a true read of performance, look at trends over at least 90 days rather than any single month. ` +
    `If anything below needs your attention, you can reply to this notice directly from your portal.`
  );
}

/**
 * Compliance guard used by fixtures AND the compose UI (soft warning):
 * affirmative assurance language must never appear; the disclaimer must.
 */
export const FORBIDDEN_ASSURANCE_PHRASES = [
  "we have audited",
  "we audited",
  "in our opinion",
  "present fairly",
  "provides assurance",
  "we have reviewed these statements in accordance",
  "review engagement",
] as const;

export function assuranceProblems(text: string): string[] {
  const t = (text || "").toLowerCase();
  return FORBIDDEN_ASSURANCE_PHRASES.filter((p) => t.includes(p));
}

// ── Ack semantics ───────────────────────────────────────────────────────────

export interface NoticeLike {
  sent_at: string;
}
export interface ReceiptLike {
  first_viewed_at?: string | null;
  acknowledged_at?: string | null;
}

/** Acked for the CURRENT text ⟺ acknowledged_at >= sent_at (re-send bumps sent_at). */
export function isAcked(receipt: ReceiptLike | null | undefined, notice: NoticeLike): boolean {
  const ack = receipt?.acknowledged_at ? Date.parse(receipt.acknowledged_at) : NaN;
  const sent = Date.parse(notice.sent_at);
  return Number.isFinite(ack) && Number.isFinite(sent) && ack >= sent;
}

/** Viewed the current text (may still be unacked). */
export function hasViewedCurrent(receipt: ReceiptLike | null | undefined, notice: NoticeLike): boolean {
  const seen = receipt?.first_viewed_at ? Date.parse(receipt.first_viewed_at) : NaN;
  const sent = Date.parse(notice.sent_at);
  return Number.isFinite(seen) && Number.isFinite(sent) && seen >= sent;
}

// ── Team-side receipt rollup ────────────────────────────────────────────────

export interface ReceiptSummary {
  portalUsers: number;
  acked: number;
  viewed: number;
  /** Days since sent with zero views of the current text; null once viewed or no users. */
  unviewedForDays: number | null;
  label: string;
}

export function receiptSummary(
  receipts: ReceiptLike[],
  portalUsers: number,
  notice: NoticeLike,
  nowMs: number
): ReceiptSummary {
  const acked = receipts.filter((r) => isAcked(r, notice)).length;
  const viewed = receipts.filter((r) => hasViewedCurrent(r, notice)).length;
  const sent = Date.parse(notice.sent_at);
  const unviewedForDays =
    portalUsers > 0 && viewed === 0 && Number.isFinite(sent)
      ? Math.max(0, Math.floor((nowMs - sent) / 86_400_000))
      : null;
  const label =
    portalUsers === 0
      ? "Notice sent — no portal logins yet for this client"
      : viewed === 0
      ? `Notice unviewed${unviewedForDays !== null ? ` for ${unviewedForDays} day${unviewedForDays === 1 ? "" : "s"}` : ""}`
      : `Notice acknowledged by ${acked} of ${portalUsers} portal user${portalUsers === 1 ? "" : "s"}`;
  return { portalUsers, acked, viewed, unviewedForDays, label };
}

// ── Email teaser ────────────────────────────────────────────────────────────

/** One tick-list line for the month-end email. NEVER carries figures or the
 *  notice's content — the email is the "come see" nudge, the portal is the
 *  content (house rule, lib/month-end/email.ts). */
export function noticeTeaserLine(): string {
  return "A Notice to Reader from your bookkeeping team — read and reply in your portal";
}

// ── AI draft ────────────────────────────────────────────────────────────────

export interface NoticeDraftInputs {
  clientName: string;
  periodLabel: string;
  /** Approved/open red-flag titles from the month's verification. */
  redFlags: string[];
  /** Internal concerns text (bookkeeper's own words — inform, never quote verbatim). */
  concerns: string | null;
  /** Open questions we've already asked the client (draft sends, ask-client, UCPI). */
  openQuestions: string[];
  /** Client messages we haven't answered yet (subjects/snippets). */
  unansweredClientMessages: string[];
}

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Pure prompt assembly — separated from the API call so fixtures can assert
 * exactly what the model is asked without a network. Degenerate inputs (empty
 * arrays, nulls) produce a "clean month" prompt rather than throwing.
 */
export function buildNoticeDraftPrompt(inputs: NoticeDraftInputs): string {
  const flags = (inputs.redFlags || []).filter(Boolean).slice(0, 12).map((f) => clamp(f, 200));
  const questions = (inputs.openQuestions || []).filter(Boolean).slice(0, 12).map((q) => clamp(q, 300));
  const unanswered = (inputs.unansweredClientMessages || []).filter(Boolean).slice(0, 8).map((m) => clamp(m, 300));
  const concerns = inputs.concerns ? clamp(inputs.concerns.trim(), 2000) : null;

  const parts: string[] = [
    `You are drafting the "This month" section of a Notice to Reader that accompanies ${inputs.clientName}'s ${inputs.periodLabel} financial statements. The reader is the business owner — a painting contractor, not an accountant.`,
    `Write two short sections in plain language:`,
    `1. "What we noticed" — the handful of things worth the owner's attention.`,
    `2. "What we need from you" — specific requests, each one answerable in a sentence.`,
    `Rules: no accounting jargon, no assurance language (never "audited", "reviewed", "opinion"), no invented numbers — only reference what is listed below. If nothing needs attention, say the month closed cleanly in one sentence and omit the requests section.`,
  ];
  if (flags.length) parts.push(`Items flagged during our checks (approved by the manager as known/explained):\n- ${flags.join("\n- ")}`);
  if (concerns) parts.push(`The bookkeeper's internal notes for context (rephrase professionally, do not quote):\n${concerns}`);
  if (questions.length) parts.push(`Questions we have already asked and are still waiting on:\n- ${questions.join("\n- ")}`);
  if (unanswered.length) parts.push(`Messages from the client we have not yet answered (acknowledge, don't re-ask):\n- ${unanswered.join("\n- ")}`);
  if (!flags.length && !concerns && !questions.length && !unanswered.length) {
    parts.push(`Nothing was flagged this month: the checks passed, there are no open questions, and no pending requests. Say so briefly and warmly; request nothing.`);
  }
  parts.push(`Length: 60–160 words total. No headings other than the two section names. No sign-off (the notice has its own).`);
  return parts.join("\n\n");
}

