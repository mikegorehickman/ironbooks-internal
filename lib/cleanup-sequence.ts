/**
 * Cleanup Sequence — the single ordered spine for cleaning up a client.
 *
 * SNAP's cleanup used to be ~10 scattered tools reached from a flat grid, the
 * sidebar, admin tiles, and kanban cards, with no shared notion of "what's the
 * next step for THIS client." This module folds them into 8 ordered steps that
 * live on the client workspace Cleanup tab. Each step deep-links the existing
 * tools (nothing is rewritten — this is the wiring layer); per-step status is
 * persisted on `client_links.cleanup_sequence` (jsonb, migration 137) so a
 * bookkeeper can mark a step done/skipped even when the underlying tool has no
 * clean "complete" signal, and anyone opening the client sees exactly where
 * cleanup stands.
 *
 * Param-convention note (see the tool href fns): the job engines (COA / reclass
 * / rules) take the client as a `?client=<id>` QUERY param — the `[id]` in
 * their own paths is the job id. The balance-sheet + revenue-check routes take
 * the client as a `[client_id]` PATH segment. Admin sweeps (duplicates,
 * payroll) are fleet pages with no per-client param. All are kept exact here so
 * the launch links land pre-scoped.
 */

export type CleanupStepKey =
  | "foundation"
  | "coa"
  | "categorize"
  | "revenue"
  | "expenses"
  | "balance_sheet"
  | "rules"
  | "verify";

export type CleanupStepStatus = "pending" | "active" | "done" | "skipped";

/** A tool folded into a step. `tab` links to a workspace tab (handled by the
 * client component via a callback, since tabs are local state, not routes);
 * `href` is a real navigable route. Exactly one of the two is set. */
export interface CleanupStepTool {
  label: string;
  desc: string;
  href?: (clientLinkId: string) => string;
  tab?: "overview" | "bs" | "pl";
}

export interface CleanupStepDef {
  key: CleanupStepKey;
  num: number;
  title: string;
  /** Plain-English "why this step exists," for the bookkeeper. */
  blurb: string;
  tools: CleanupStepTool[];
}

export const CLEANUP_STEPS: CleanupStepDef[] = [
  {
    key: "foundation",
    num: 1,
    title: "Foundation & documents",
    blurb:
      "Get every bank, credit-card and loan statement in, and confirm the full list of accounts. Nothing downstream can be right until the source docs are here.",
    tools: [
      {
        label: "Statements & documents",
        desc: "Request / receive statements and enumerate all accounts",
        tab: "overview",
      },
      {
        label: "Balance Sheet workspace",
        desc: "See the account list and starting balances",
        href: (id) => `/balance-sheet/${id}`,
      },
    ],
  },
  {
    key: "coa",
    num: 2,
    title: "Chart of accounts",
    blurb:
      "Conform the client's chart to the master: rename, merge, re-type and inactivate so every later step maps to the right account.",
    tools: [
      {
        label: "COA Cleanup",
        desc: "Rename / merge / retype / inactivate to master",
        href: (id) => `/jobs/new?client=${id}`,
      },
      {
        label: "COA Audit",
        desc: "Conformance check vs the master chart",
        href: () => `/coa-audit`,
      },
    ],
  },
  {
    key: "categorize",
    num: 3,
    title: "Categorize transactions",
    blurb:
      "AI-reclassify posted transactions, route transfers / CC-payments / loan-payments off the P&L, and ask the client about anything unclear.",
    tools: [
      {
        label: "Reclassify",
        desc: "AI re-map posted transactions + ask-client",
        href: (id) => `/reclass/new?client=${id}`,
      },
    ],
  },
  {
    key: "revenue",
    num: 4,
    title: "Revenue integrity",
    blurb:
      "Make revenue real: clear deposits booked as sales, resolve CRM-invoice double-counts, empty Undeposited Funds, and true up A/R.",
    tools: [
      {
        label: "Revenue check",
        desc: "Deposits-as-revenue & CRM-invoice double-count",
        href: (id) => `/revenue-check/${id}`,
      },
      {
        label: "UF Audit",
        desc: "Clear stuck Undeposited Funds",
        href: (id) => `/balance-sheet/${id}/uf-audit`,
      },
      {
        label: "UF / A/R Reconciler",
        desc: "Match deposits to revenue, true up A/R",
        href: (id) => `/balance-sheet/${id}/ufar-recon`,
      },
    ],
  },
  {
    key: "expenses",
    num: 5,
    title: "Expenses & duplicates",
    blurb:
      "Kill double-counted costs: duplicate bills/expenses, payroll booked twice (gross paycheque + net deposit), and — for CA clients — GST/HST split.",
    tools: [
      {
        label: "Duplicate expenses",
        desc: "Find & clear duplicate bills / expenses",
        href: () => `/admin/duplicates`,
      },
      {
        label: "Payroll double-count",
        desc: "Gross paycheque + net deposit double-expensed",
        href: () => `/admin/payroll-double-scan`,
      },
    ],
  },
  {
    key: "balance_sheet",
    num: 6,
    title: "Balance sheet",
    blurb:
      "Reconcile bank / credit-card / loan balances to statements, fix the opening balance, and clear the A/P and A/R aging.",
    tools: [
      {
        label: "Balance Sheet Cleanup",
        desc: "Reconcile bank / CC / loan, OBE, A/R, A/P",
        href: (id) => `/balance-sheet/${id}/cleanup`,
      },
      {
        label: "Hardcore BS Cleanup",
        desc: "CSV-driven statement reconciliation",
        href: (id) => `/balance-sheet/${id}/hardcore-cleanup`,
      },
    ],
  },
  {
    key: "rules",
    num: 7,
    title: "Bank rules",
    blurb:
      "Capture what you just learned as go-forward auto-categorization rules, then export them into QBO so daily recon stays clean.",
    tools: [
      {
        label: "Bank Rules",
        desc: "Learn & export go-forward rules",
        href: (id) => `/rules/new?client=${id}`,
      },
    ],
  },
  {
    key: "verify",
    num: 8,
    title: "Verify & first statements",
    blurb:
      "Run the Books Reliability checks, send draft statements for the first months, and get the client to attest — this graduates them to Production.",
    tools: [
      {
        label: "Verify & statements",
        desc: "Books Reliability score, draft statements, attest",
        href: () => `/production`,
      },
    ],
  },
];

export const CLEANUP_STEP_KEYS: CleanupStepKey[] = CLEANUP_STEPS.map((s) => s.key);

export interface CleanupStepState {
  status: CleanupStepStatus;
  note?: string;
  at?: string | null;
  by?: string | null;
}

export interface CleanupSequenceState {
  steps: Partial<Record<CleanupStepKey, CleanupStepState>>;
}

export function isCleanupStepKey(v: any): v is CleanupStepKey {
  return typeof v === "string" && (CLEANUP_STEP_KEYS as string[]).includes(v);
}

export function isCleanupStepStatus(v: any): v is CleanupStepStatus {
  return v === "pending" || v === "active" || v === "done" || v === "skipped";
}

/** Normalize whatever is on the row into a well-formed state object. */
export function readCleanupSequence(
  row: { cleanup_sequence?: any } | null | undefined
): CleanupSequenceState {
  const raw = (row?.cleanup_sequence || {}) as any;
  const steps: CleanupSequenceState["steps"] = {};
  const rawSteps = raw.steps && typeof raw.steps === "object" ? raw.steps : {};
  for (const key of CLEANUP_STEP_KEYS) {
    const s = rawSteps[key];
    if (s && isCleanupStepStatus(s.status)) {
      steps[key] = {
        status: s.status,
        note: typeof s.note === "string" ? s.note : undefined,
        at: s.at ?? null,
        by: s.by ?? null,
      };
    }
  }
  return { steps };
}

/** External signals we can auto-derive a step's status from without a manual
 * mark. Kept intentionally small — only the terminal cleanup flag is reliable
 * fleet-wide today; the rest of the auto-derivation can grow later. */
export interface CleanupSignals {
  cleanupCompletedAt?: string | null;
}

/**
 * Effective status for one step: a bookkeeper's manual mark always wins; else
 * we auto-derive what we can (a completed cleanup means Verify is done and
 * everything before it is implicitly done too); else pending.
 */
export function effectiveStepStatus(
  state: CleanupSequenceState,
  key: CleanupStepKey,
  signals: CleanupSignals = {}
): CleanupStepStatus {
  const manual = state.steps[key];
  if (manual) return manual.status;
  if (signals.cleanupCompletedAt) return "done";
  return "pending";
}

/**
 * The step the bookkeeper should be on now: the first step that isn't done or
 * skipped. Returns null when every step is done/skipped (cleanup is finished).
 */
export function activeCleanupStep(
  state: CleanupSequenceState,
  signals: CleanupSignals = {}
): CleanupStepKey | null {
  for (const step of CLEANUP_STEPS) {
    const st = effectiveStepStatus(state, step.key, signals);
    if (st !== "done" && st !== "skipped") return step.key;
  }
  return null;
}

/** Count of steps considered finished (done or skipped) out of the total. */
export function cleanupProgress(
  state: CleanupSequenceState,
  signals: CleanupSignals = {}
): { done: number; total: number } {
  let done = 0;
  for (const step of CLEANUP_STEPS) {
    const st = effectiveStepStatus(state, step.key, signals);
    if (st === "done" || st === "skipped") done++;
  }
  return { done, total: CLEANUP_STEPS.length };
}
