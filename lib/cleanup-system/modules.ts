/**
 * Module discovery — wraps existing BS modules under the orchestrator.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createProposedEntry } from "./proposed-entries";
import { createCpaFlag, requiresCpaFlag } from "./cpa-flags";
import type { CleanupModule } from "./types";
import { discoverUndepositedFundsModule } from "./uf-discovery";
import {
  discoverAccountsReceivableModule,
  type ArDiscoverOptions,
} from "./ar-discovery";
import { getValidToken, fetchAllAccounts } from "@/lib/qbo";
import { resolveAccount } from "@/lib/qbo-journal-entry";
import { analyzeClientLoans } from "@/lib/loan-analyzer";

const round2 = (n: number) => Math.round(n * 100) / 100;
const todayIso = () => new Date().toISOString().slice(0, 10);

/** realm + token for modules that read QBO live. Throws if not connected. */
async function qboContext(service: SupabaseClient, clientLinkId: string) {
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  const realmId = (client as any)?.qbo_realm_id as string;
  if (!realmId) throw new Error("Client has no QBO connection");
  const accessToken = await getValidToken(clientLinkId, service);
  return { realmId, accessToken };
}

export async function discoverBankReconModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  // Link any existing per-account recon rows from the legacy BS landing flow.
  await service
    .from("bank_recon_jobs")
    .update({ cleanup_run_id: runId } as any)
    .eq("client_link_id", clientLinkId)
    .is("cleanup_run_id", null);

  const { data: recons } = await service
    .from("bank_recon_jobs")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .or(`cleanup_run_id.eq.${runId},cleanup_run_id.is.null`);

  let proposed = 0;
  for (const recon of recons || []) {
    const gap = Number((recon as any).gap_amount || 0);
    if (Math.abs(gap) < 0.01) continue;

    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "bank_recon",
      entryType: "journal_entry",
      amount: Math.abs(gap),
      txnDate: (recon as any).statement_as_of_date,
      memo: `Bank recon gap for ${(recon as any).qbo_account_name}`,
      jeLines: [
        {
          side: gap > 0 ? "debit" : "credit",
          account_hint: (recon as any).qbo_account_name,
          amount: Math.abs(gap),
          description: "Statement reconciliation adjustment",
        },
        {
          side: gap > 0 ? "credit" : "debit",
          account_hint: "Balance Sheet Cleanup Clearing",
          amount: Math.abs(gap),
          description: "Clearing offset",
        },
      ],
      periodImpact: "clearing_entry",
    });
    proposed++;
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "bank_recon");

  return { proposed };
}

export async function discoverAccountsPayableModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  // Scaffold: AP discovery pulls open bills with payments — extend when QBO bill fetch wired
  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: 0 } as any)
    .eq("run_id", runId)
    .eq("module", "accounts_payable");
  return { proposed: 0 };
}

/**
 * Loans — real P&I splits (replaces the old hardcoded 80/20 scaffold).
 *
 * Detects the client's loan liability accounts + the payments posted to them
 * live from QBO, then splits interest out via lib/loan-analyzer:
 *   statement_interest (lender CSV had an interest column — exact) →
 *   stated_rate (rate in the account name — declining-balance estimate) →
 *   unsolvable (flag the problem; never invent a ratio).
 *
 * One correction JE per loan per period bucket: DR Interest Expense /
 * CR Loan account, pulling the interest that was wrongly posted as principal.
 * Splits dated in the locked period post as cpa_blocked (need sign-off);
 * open-period splits post as current, dated today.
 */
export async function discoverLoansModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string
): Promise<{ proposed: number }> {
  const { data: loanImports } = await service
    .from("imported_records")
    .select("*")
    .eq("run_id", runId)
    .eq("source", "loan_statement");

  // Lender → statement rows (fee_amount = interest when the CSV carried it).
  const statementRowsByLender = new Map<
    string,
    Array<{ date: string | null; gross: number; interest: number }>
  >();
  for (const rec of loanImports || []) {
    const lender = String((rec as any).payer_raw || "").trim() || "(unknown lender)";
    if (!statementRowsByLender.has(lender)) statementRowsByLender.set(lender, []);
    statementRowsByLender.get(lender)!.push({
      date: (rec as any).record_date || null,
      gross: Number((rec as any).gross_amount || 0),
      interest: Number((rec as any).fee_amount || 0),
    });
  }

  let proposed = 0;

  try {
    const { realmId, accessToken } = await qboContext(service, clientLinkId);
    const accounts = await fetchAllAccounts(realmId, accessToken);
    const interest = resolveAccount("Interest Expense", accounts as any);
    const analyses = await analyzeClientLoans(realmId, accessToken, statementRowsByLender);

    for (const a of analyses) {
      if (a.method === "unsolvable") {
        if (a.payments.length === 0) continue; // clean loan — nothing to say
        await createProposedEntry(service, {
          runId,
          clientLinkId,
          module: "loans",
          entryType: "journal_entry",
          amount: round2(a.payments.reduce((s, p) => s + p.amount, 0)),
          txnDate: todayIso(),
          memo: `Loan P&I split needed — ${a.accountName}: ${a.note}`,
          fromAccountId: a.accountId,
          fromAccountName: a.accountName,
          decisionOverride: "flagged",
          confidenceOverride: 0,
          aiReasoning: JSON.stringify({
            v: 1,
            type: "loan_pi_split",
            method: a.method,
            payments: a.payments.slice(0, 60),
          }),
        });
        proposed++;
        continue;
      }

      // Bucket the interest by whether the underlying payment sits in the
      // locked period — locked-period corrections need CPA sign-off.
      const buckets: Array<{ key: "open" | "closed"; splits: typeof a.splits }> = [
        { key: "open", splits: a.splits.filter((s) => !s.date || s.date > periodLockDate) },
        { key: "closed", splits: a.splits.filter((s) => !!s.date && s.date <= periodLockDate) },
      ];

      for (const bucket of buckets) {
        const totalInterest = round2(bucket.splits.reduce((s, x) => s + x.interest, 0));
        if (totalInterest < 0.01) continue;

        let cpaFlagId: string | undefined;
        if (bucket.key === "closed") {
          cpaFlagId = await createCpaFlag(service, {
            clientLinkId,
            runId,
            flagType: "prior_year_expense",
            description: `Loan interest split for ${a.accountName}: $${totalInterest.toFixed(2)} of interest belongs to payments dated on/before the period lock (${periodLockDate})`,
            impactSummary: "Posting adds prior-period interest expense in the current period — CPA sign-off required",
          });
        }

        const methodLabel =
          a.method === "statement_interest"
            ? "per lender statement"
            : `estimated at the ${a.statedAnnualRatePct}% stated rate`;

        await createProposedEntry(service, {
          runId,
          clientLinkId,
          module: "loans",
          entryType: "journal_entry",
          amount: totalInterest,
          txnDate: todayIso(),
          memo: `Loan P&I split — ${a.accountName}: reclass $${totalInterest.toFixed(2)} interest (${bucket.splits.length} payment${bucket.splits.length === 1 ? "" : "s"}, ${methodLabel}) out of principal`,
          fromAccountId: a.accountId,
          fromAccountName: a.accountName,
          jeLines: [
            {
              side: "debit",
              account_hint: "Interest Expense",
              ...(interest.ok
                ? { qbo_account_id: interest.qbo_account_id, qbo_account_name: interest.qbo_account_name }
                : {}),
              amount: totalInterest,
              description: `Interest on ${a.accountName} (${methodLabel})`,
            } as any,
            {
              side: "credit",
              account_hint: a.accountName,
              qbo_account_id: a.accountId,
              qbo_account_name: a.accountName,
              amount: totalInterest,
              description: "Reclass interest out of loan principal",
            } as any,
          ],
          periodImpact: cpaFlagId ? "cpa_blocked" : "current",
          cpaFlagId,
          decisionOverride: "needs_review",
          confidenceOverride: a.method === "statement_interest" ? 0.9 : 0.75,
          aiReasoning: JSON.stringify({
            v: 1,
            type: "loan_pi_split",
            method: a.method,
            stated_rate_pct: a.statedAnnualRatePct,
            bucket: bucket.key,
            splits: bucket.splits.slice(0, 60),
          }),
        });
        proposed++;
      }
    }
  } catch (err: any) {
    // QBO unavailable — statement-only fallback. Rows with REAL interest still
    // produce exact booking proposals (flagged: bookkeeper picks the bank
    // account); we never fall back to an invented ratio.
    console.warn(`[loans] QBO analysis failed (${err?.message}) — statement-only fallback`);
    for (const rec of loanImports || []) {
      const gross = Number((rec as any).gross_amount || 0);
      const intAmt = Number((rec as any).fee_amount || 0);
      if (gross <= 0 || intAmt <= 0 || intAmt >= gross) continue;
      await createProposedEntry(service, {
        runId,
        clientLinkId,
        module: "loans",
        entryType: "journal_entry",
        amount: gross,
        txnDate: (rec as any).record_date || todayIso(),
        memo: `Loan payment per statement — ${(rec as any).payer_raw}: $${(gross - intAmt).toFixed(2)} principal + $${intAmt.toFixed(2)} interest`,
        jeLines: [
          { side: "debit", account_hint: (rec as any).payer_raw || "Loan Account", amount: round2(gross - intAmt), description: "Principal" },
          { side: "debit", account_hint: "Interest Expense", amount: round2(intAmt), description: "Interest (per lender statement)" },
          { side: "credit", account_hint: "Bank account used for loan payments", amount: gross, description: "Payment" },
        ],
        decisionOverride: "flagged",
        confidenceOverride: 0.5,
        aiReasoning: JSON.stringify({ v: 1, type: "loan_pi_split", method: "statement_interest", fallback: "qbo_unavailable" }),
      });
      proposed++;
    }
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "loans");

  return { proposed };
}

// Equity accounts that must NEVER be folded into the owner account.
const EQUITY_KEEP_RE =
  /retained earnings|opening balance|common stock|share capital|preferred|paid.?in capital|treasury|dividend|accumulated/i;
const DRAW_TARGET_RE = /owner.?s?\s*draw|shareholder\s*draw/i;

/**
 * Shareholder Draws / Owner Equity — consolidate to ONE account.
 *
 * The mess: 6–7 owner equity accounts (Draws, Contributions, "Owner's Pay",
 * "Due to Owner" as equity, …) scattering money-in/money-out. The standard:
 * ONE owner account (master COA's "Owner's Draw"). Proposes a balance-transfer
 * JE per redundant account into the target, then the emptied account gets
 * deactivated by the bookkeeper (noted in the memo — the COA tools handle it).
 *
 * Equity moves always require CPA sign-off (system-wide rule via
 * requiresCpaFlag("equity")), so every proposal posts as cpa_blocked.
 */
export async function discoverShareholderDrawsModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  let proposed = 0;

  try {
    const { realmId, accessToken } = await qboContext(service, clientLinkId);
    const accounts = await fetchAllAccounts(realmId, accessToken);

    const equity = accounts.filter(
      (a) =>
        a.Active !== false &&
        a.AccountType === "Equity" &&
        !EQUITY_KEEP_RE.test(a.Name) &&
        a.AccountSubType !== "RetainedEarnings" &&
        a.AccountSubType !== "OpeningBalanceEquity"
    );

    if (equity.length > 1) {
      // Target: the master-COA draw account when present, else the account
      // already carrying the most weight.
      const target =
        equity.find((a) => DRAW_TARGET_RE.test(a.Name)) ||
        [...equity].sort(
          (x, y) => Math.abs(y.CurrentBalance || 0) - Math.abs(x.CurrentBalance || 0)
        )[0];

      for (const acct of equity) {
        if (acct.Id === target.Id) continue;
        const bal = Number(acct.CurrentBalance || 0);
        if (Math.abs(bal) < 0.01) continue; // empty — just deactivate via COA tools

        const cpaFlagId = requiresCpaFlag(todayIso(), todayIso(), "equity")
          ? await createCpaFlag(service, {
              clientLinkId,
              runId,
              flagType: "equity_consolidation",
              description: `Fold "${acct.Name}" ($${Math.abs(bal).toFixed(2)}) into "${target.Name}" — one owner equity account`,
              impactSummary: "Equity restructure — CPA sign-off before posting",
            })
          : undefined;

        // QBO equity balances report credit-positive: positive balance →
        // debit the source to zero it, credit the target (and vice versa).
        const src = { qbo_account_id: acct.Id, qbo_account_name: acct.Name, account_hint: acct.Name };
        const tgt = { qbo_account_id: target.Id, qbo_account_name: target.Name, account_hint: target.Name };
        await createProposedEntry(service, {
          runId,
          clientLinkId,
          module: "shareholder_draws",
          entryType: "journal_entry",
          amount: Math.abs(bal),
          txnDate: todayIso(),
          memo: `Consolidate equity: move $${Math.abs(bal).toFixed(2)} from "${acct.Name}" to "${target.Name}". After posting, deactivate "${acct.Name}" (COA editor) so all owner money-in/out lives in one account.`,
          fromAccountId: acct.Id,
          fromAccountName: acct.Name,
          toAccountId: target.Id,
          toAccountName: target.Name,
          jeLines: [
            { side: bal > 0 ? "debit" : "credit", ...src, amount: Math.abs(bal), description: "Zero out redundant equity account" } as any,
            { side: bal > 0 ? "credit" : "debit", ...tgt, amount: Math.abs(bal), description: "Consolidated owner equity" } as any,
          ],
          periodImpact: cpaFlagId ? "cpa_blocked" : "current",
          cpaFlagId,
          decisionOverride: "needs_review",
          confidenceOverride: 0.8,
          aiReasoning: JSON.stringify({
            v: 1,
            type: "equity_consolidation",
            target: { id: target.Id, name: target.Name },
            source: { id: acct.Id, name: acct.Name, balance: bal },
            equity_account_count: equity.length,
          }),
        });
        proposed++;
      }
    }
  } catch (err: any) {
    console.warn(`[shareholder_draws] discovery failed: ${err?.message}`);
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "shareholder_draws");
  return { proposed };
}

// Lump payroll accounts that need splitting — NOT the master buckets themselves.
const PAYROLL_SOURCE_RE = /payroll|wages|salar|labou?r/i;
const PAYROLL_BUCKET_RE = /direct field|owner.?s? payroll|admin payroll|ops manager|employer payroll tax/i;
const PAYROLL_TAX_RE = /payroll tax|source deduction|\bcpp\b|\bei\b|employer tax|remittance/i;

/**
 * Sales Tax & Payroll — wage allocation + the CPA tie-out flag.
 *
 * The mess: every paycheque lumped into one "Payroll Expense" account, so
 * field labour (a JOB cost that belongs in COGS) is indistinguishable from
 * owner/admin wages (overhead). This module aggregates the lump account(s) by
 * payee, classifies each payee (owner = name-match, crew/admin/manager =
 * Haiku over the payee list), and proposes one reallocation JE per payee into
 * the master buckets. Employer payroll taxes move to the Field bucket
 * pro-rata to the classified field-wage share. Unknown payees are FLAGGED —
 * never guessed into COGS.
 *
 * Statutory liability tie-out (GST/HST, source deductions, corp tax) stays a
 * CPA flag — that reconciliation lives in the CPA round-trip surface.
 */
export async function discoverTaxPayrollModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string
): Promise<{ proposed: number }> {
  await createCpaFlag(service, {
    clientLinkId,
    runId,
    flagType: "tax_payroll_review",
    description: "Sales tax and payroll liabilities require manual tie-out to filed amounts",
    impactSummary: "CPA review recommended before posting tax/payroll adjustments",
  });

  let proposed = 0;

  try {
    const { realmId, accessToken } = await qboContext(service, clientLinkId);
    const [{ fetchTransactionsForAccount }, accounts, { data: cl }] = await Promise.all([
      import("@/lib/qbo"),
      fetchAllAccounts(realmId, accessToken),
      service
        .from("client_links")
        .select("client_name, legal_business_name, contact_first_name, contact_last_name")
        .eq("id", clientLinkId)
        .single(),
    ]);
    const { aggregateByPayee, classifyPayees, fieldWageRatio, ROLE_TARGET_HINTS } = await import(
      "@/lib/payroll-allocator"
    );

    const sources = accounts.filter(
      (a) =>
        a.Active !== false &&
        a.AccountType === "Expense" &&
        PAYROLL_SOURCE_RE.test(a.Name) &&
        !PAYROLL_BUCKET_RE.test(a.Name) &&
        !PAYROLL_TAX_RE.test(a.Name) &&
        !/subcontract/i.test(a.Name)
    );
    const taxSources = accounts.filter(
      (a) =>
        a.Active !== false &&
        a.AccountType === "Expense" &&
        PAYROLL_TAX_RE.test(a.Name) &&
        !PAYROLL_BUCKET_RE.test(a.Name)
    );

    const ownerNames = [
      `${(cl as any)?.contact_first_name || ""} ${(cl as any)?.contact_last_name || ""}`,
      (cl as any)?.client_name || "",
    ].filter((s) => s.trim().length > 2);
    const company =
      (cl as any)?.legal_business_name || (cl as any)?.client_name || "the client";

    for (const src of sources) {
      // Open-period postings only — reallocating locked months restates them.
      const byType = await fetchTransactionsForAccount(realmId, accessToken, src.Id, ["Purchase"]);
      const txns: Array<{ payee: string | null; amount: number }> = [];
      for (const { transactions } of byType) {
        for (const tx of transactions) {
          if (!tx.TxnDate || tx.TxnDate <= periodLockDate) continue;
          const hit = (tx.Line || [])
            .filter((l: any) => l?.AccountBasedExpenseLineDetail?.AccountRef?.value === src.Id)
            .reduce((s: number, l: any) => s + Number(l.Amount || 0), 0);
          if (hit > 0.005) txns.push({ payee: (tx as any).EntityRef?.name || null, amount: hit });
        }
      }
      if (txns.length === 0) continue;

      const payees = aggregateByPayee(txns);
      if (payees.length === 0) continue;
      const classified = await classifyPayees(payees, ownerNames, company);

      for (const c of classified) {
        if (c.role === "unknown") {
          await createProposedEntry(service, {
            runId,
            clientLinkId,
            module: "tax_payroll",
            entryType: "journal_entry",
            amount: c.total,
            txnDate: todayIso(),
            memo: `Payroll allocation — can't classify "${c.payee}" ($${c.total.toFixed(2)}, ${c.txnCount} payments from ${src.Name}): ${c.reason}. Classify manually (field crew → Direct Field Labor; office → Admin Payroll).`,
            fromAccountId: src.Id,
            fromAccountName: src.Name,
            decisionOverride: "flagged",
            confidenceOverride: 0,
            aiReasoning: JSON.stringify({ v: 1, type: "payroll_allocation", payee: c.payee, role: c.role, reason: c.reason }),
          });
          proposed++;
          continue;
        }

        const targetHint = ROLE_TARGET_HINTS[c.role];
        const target = resolveAccount(targetHint, accounts as any);
        const unresolved = !target.ok;
        await createProposedEntry(service, {
          runId,
          clientLinkId,
          module: "tax_payroll",
          entryType: "journal_entry",
          amount: c.total,
          txnDate: todayIso(),
          memo: unresolved
            ? `Reallocate ${c.payee} wages → ${targetHint}: target account not found in the chart — run COA standardization first, then re-run this module.`
            : `Reallocate ${c.payee} wages ($${c.total.toFixed(2)}, ${c.role}) from ${src.Name} → ${targetHint} (${c.reason})`,
          fromAccountId: src.Id,
          fromAccountName: src.Name,
          ...(target.ok ? { toAccountId: target.qbo_account_id, toAccountName: target.qbo_account_name } : {}),
          jeLines: [
            {
              side: "debit",
              account_hint: targetHint,
              ...(target.ok ? { qbo_account_id: target.qbo_account_id, qbo_account_name: target.qbo_account_name } : {}),
              amount: c.total,
              description: `${c.payee} — ${c.role} wages`,
            } as any,
            {
              side: "credit",
              account_hint: src.Name,
              qbo_account_id: src.Id,
              qbo_account_name: src.Name,
              amount: c.total,
              description: `Reallocate out of ${src.Name}`,
            } as any,
          ],
          periodImpact: "current",
          decisionOverride: unresolved ? "flagged" : "needs_review",
          confidenceOverride: unresolved ? 0 : Math.min(0.9, c.confidence),
          aiReasoning: JSON.stringify({
            v: 1,
            type: "payroll_allocation",
            payee: c.payee,
            role: c.role,
            confidence: c.confidence,
            reason: c.reason,
            source_account: src.Name,
          }),
        });
        proposed++;
      }

      // Employer payroll taxes follow the wages: move the field share into the
      // Field tax bucket pro-rata to the classified field-wage ratio.
      const ratio = fieldWageRatio(classified);
      if (ratio > 0.05) {
        for (const taxSrc of taxSources) {
          const taxByType = await fetchTransactionsForAccount(realmId, accessToken, taxSrc.Id, ["Purchase"]);
          let taxTotal = 0;
          for (const { transactions } of taxByType) {
            for (const tx of transactions) {
              if (!tx.TxnDate || tx.TxnDate <= periodLockDate) continue;
              taxTotal += (tx.Line || [])
                .filter((l: any) => l?.AccountBasedExpenseLineDetail?.AccountRef?.value === taxSrc.Id)
                .reduce((s: number, l: any) => s + Number(l.Amount || 0), 0);
            }
          }
          const fieldShare = round2(taxTotal * ratio);
          if (fieldShare < 1) continue;
          const taxTarget = resolveAccount("Employer Payroll Taxes - Field", accounts as any);
          await createProposedEntry(service, {
            runId,
            clientLinkId,
            module: "tax_payroll",
            entryType: "journal_entry",
            amount: fieldShare,
            txnDate: todayIso(),
            memo: `Employer payroll taxes — move field share ($${fieldShare.toFixed(2)} = ${(ratio * 100).toFixed(1)}% of $${round2(taxTotal).toFixed(2)}, pro-rata to classified field wages) from ${taxSrc.Name} into the Field bucket`,
            fromAccountId: taxSrc.Id,
            fromAccountName: taxSrc.Name,
            jeLines: [
              {
                side: "debit",
                account_hint: "Employer Payroll Taxes - Field",
                ...(taxTarget.ok ? { qbo_account_id: taxTarget.qbo_account_id, qbo_account_name: taxTarget.qbo_account_name } : {}),
                amount: fieldShare,
                description: "Field share of employer payroll taxes",
              } as any,
              {
                side: "credit",
                account_hint: taxSrc.Name,
                qbo_account_id: taxSrc.Id,
                qbo_account_name: taxSrc.Name,
                amount: fieldShare,
                description: "Pro-rata reallocation",
              } as any,
            ],
            periodImpact: "current",
            decisionOverride: taxTarget.ok ? "needs_review" : "flagged",
            confidenceOverride: taxTarget.ok ? 0.7 : 0,
            aiReasoning: JSON.stringify({ v: 1, type: "payroll_tax_prorata", ratio, tax_total: round2(taxTotal) }),
          });
          proposed++;
        }
      }
    }
  } catch (err: any) {
    console.warn(`[tax_payroll] wage-allocation discovery failed: ${err?.message}`);
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "tax_payroll");

  return { proposed };
}

export async function discoverObeUncategorizedModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  const { data: healthScore } = await service
    .from("bs_health_scores")
    .select("account_grades")
    .eq("run_id", runId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const grades = ((healthScore as any)?.account_grades || []) as Array<{
    qbo_account_id: string;
    account_name: string;
    balance: number;
    module: string;
  }>;

  let proposed = 0;
  for (const acct of grades.filter((g) => g.module === "obe_uncategorized")) {
    if (Math.abs(acct.balance) < 0.01) continue;
    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "obe_uncategorized",
      entryType: "journal_entry",
      amount: Math.abs(acct.balance),
      memo: `Zero out ${acct.account_name}`,
      jeLines: [
        {
          side: acct.balance > 0 ? "credit" : "debit",
          account_hint: acct.account_name,
          amount: Math.abs(acct.balance),
          description: "OBE/uncat cleanup",
        },
        {
          side: acct.balance > 0 ? "debit" : "credit",
          account_hint: "Balance Sheet Cleanup Clearing",
          amount: Math.abs(acct.balance),
          description: "Clearing offset",
        },
      ],
      periodImpact: "clearing_entry",
    });
    proposed++;
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "obe_uncategorized");

  return { proposed };
}

const DISCOVERERS: Record<
  CleanupModule,
  (
    service: SupabaseClient,
    runId: string,
    clientLinkId: string,
    periodLockDate: string,
    options?: ArDiscoverOptions
  ) => Promise<{ proposed: number }>
> = {
  bank_recon: (s, r, c) => discoverBankReconModule(s, r, c),
  undeposited_funds: (s, r, c, d) => discoverUndepositedFundsModule(s, r, c, d),
  accounts_receivable: (s, r, c, d, o) =>
    discoverAccountsReceivableModule(s, r, c, d, o || {}),
  accounts_payable: (s, r, c) => discoverAccountsPayableModule(s, r, c),
  loans: (s, r, c, d) => discoverLoansModule(s, r, c, d),
  shareholder_draws: (s, r, c) => discoverShareholderDrawsModule(s, r, c),
  tax_payroll: (s, r, c, d) => discoverTaxPayrollModule(s, r, c, d),
  obe_uncategorized: (s, r, c) => discoverObeUncategorizedModule(s, r, c),
};

export async function discoverModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  module: CleanupModule,
  periodLockDate: string,
  options?: ArDiscoverOptions
): Promise<{ proposed: number }> {
  await service
    .from("cleanup_run_modules")
    .update({ status: "discovering", started_at: new Date().toISOString() } as any)
    .eq("run_id", runId)
    .eq("module", module);

  const result = await DISCOVERERS[module](
    service,
    runId,
    clientLinkId,
    periodLockDate,
    options
  );
  return result;
}
