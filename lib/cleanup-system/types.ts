/**
 * Balance Sheet Cleanup System — shared types and constants.
 */

export type CleanupRunStatus =
  | "discovering"
  | "reviewing"
  | "executing"
  | "complete"
  | "failed"
  | "cancelled";

export type CleanupWorkflowMode = "onboarding" | "monthly_close";

export type CleanupModule =
  | "bank_recon"
  | "undeposited_funds"
  | "accounts_receivable"
  | "accounts_payable"
  | "loans"
  | "shareholder_draws"
  | "tax_payroll"
  | "obe_uncategorized";

export type CleanupModuleStatus =
  | "locked"
  | "ready"
  | "discovering"
  | "reviewing"
  | "executing"
  | "complete"
  | "skipped"
  | "failed";

export type HealthGrade = "green" | "yellow" | "red";

export type PeriodImpact = "current" | "clearing_entry" | "cpa_blocked";

export type ProposedEntryType =
  | "reclass"
  | "journal_entry"
  | "receive_payment"
  | "bill_payment"
  | "void"
  | "invoice";

export type ImportSource = "bank" | "stripe" | "jobber" | "drip_jobs" | "loan_statement";

export type CpaFlagStatus = "open" | "signed_off" | "dismissed";

/**
 * Module display + seeding order. Modules are NO LONGER gated sequentially —
 * every module is seeded "ready" so a bookkeeper can run any of them in any
 * order. This array just controls the order they appear in and which modules
 * a new run seeds. (OBE & Uncategorized Cleanup was retired from the workflow;
 * the type + discovery handler are kept for backward-compat with old runs but
 * it is no longer seeded into new runs.)
 */
export const MODULE_ORDER: CleanupModule[] = [
  "accounts_receivable",
  "undeposited_funds",
  "accounts_payable",
  "loans",
  "shareholder_draws",
  "tax_payroll",
  "bank_recon",
];

export const MODULE_LABELS: Record<CleanupModule, string> = {
  bank_recon: "Bank & Credit Card Reconciliation",
  undeposited_funds: "Undeposited Funds",
  accounts_receivable: "Accounts Receivable",
  accounts_payable: "Accounts Payable",
  loans: "Loans",
  shareholder_draws: "Shareholder Draws / Loans",
  tax_payroll: "Sales Tax & Payroll Liabilities",
  obe_uncategorized: "OBE & Uncategorized Cleanup",
};

export const CLEARING_ACCOUNT_NAME = "Balance Sheet Cleanup Clearing";

export interface AccountGrade {
  qbo_account_id: string;
  account_name: string;
  account_type: string;
  balance: number;
  grade: HealthGrade;
  issue: string;
  module: CleanupModule | null;
  priority: number;
}

export interface HealthTask {
  id: string;
  title: string;
  description: string;
  module: CleanupModule;
  grade: HealthGrade;
  priority: number;
}

export interface CanonicalRecord {
  source: ImportSource;
  external_id: string;
  date: string | null;
  payer_raw: string | null;
  payer_normalized: string | null;
  gross_amount: number | null;
  fee_amount: number;
  tax_amount: number;
  net_amount: number | null;
  reference: string | null;
  payout_id: string | null;
  currency: string;
  type: string | null;
}

export interface MatchResult {
  match_type: string;
  confidence: number;
  gross_amount: number | null;
  fee_amount: number;
  tax_amount: number;
  net_amount: number | null;
  proposed_fix: Record<string, unknown>;
  reasons: string[];
  source_record_ids: string[];
  qbo_refs: Record<string, unknown>;
}

export const ACTIVE_CLEANUP_STATUSES: CleanupRunStatus[] = [
  "discovering",
  "reviewing",
  "executing",
];
