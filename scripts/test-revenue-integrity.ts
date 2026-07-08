// Unit tests for lib/revenue-integrity.ts — run: npx tsx scripts/test-revenue-integrity.ts
import { analyzeDepositsToIncome, DEPOSIT_TO_INCOME_FLOOR } from "@/lib/revenue-integrity";
import type { PLDetailRow } from "@/lib/qbo-reports";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

const row = (p: Partial<PLDetailRow>): PLDetailRow => ({
  txn_id: p.txn_id || "1", txn_type: p.txn_type || "Invoice", date: p.date || "2026-06-01",
  doc_number: p.doc_number ?? null, name: p.name ?? null, memo: "", amount: p.amount ?? 100,
  running_balance: null, account: p.account || "Carpet Cleaning Revenue", section: "Income",
});

const ACCOUNTS = [
  { name: "Carpet Cleaning Revenue", accountType: "Income" },
  { name: "Sales of Product Income", accountType: "Income" },
  { name: "Gain on Sold Assets", accountType: "Other Income" },
  { name: "Job Supplies", accountType: "Expense" },
];

// 1. The CYC pattern: invoice-driven book with lump-sum deposits into revenue.
{
  const detail: PLDetailRow[] = [
    ...Array.from({ length: 20 }, (_, i) => row({ txn_id: `inv${i}`, txn_type: "Invoice", amount: 500, name: "Customer " + i, doc_number: String(4000 + i), account: "Sales of Product Income" })),
    row({ txn_id: "d1", txn_type: "Deposit", amount: 15309, account: "Carpet Cleaning Revenue" }),
    row({ txn_id: "d2", txn_type: "Deposit", amount: 2876, account: "Carpet Cleaning Revenue" }),
    row({ txn_id: "gi", txn_type: "Deposit", amount: 16000, account: "Gain on Sold Assets" }),
    row({ txn_id: "ex", txn_type: "Expense", amount: 50, account: "Job Supplies" }),
  ];
  const r = analyzeDepositsToIncome(detail, ACCOUNTS);
  ok(r.flagged, "CYC pattern flags");
  ok(r.depositCount === 2 && Math.round(r.depositTotal) === 18185, `deposit rows/total (${r.depositCount}, ${r.depositTotal})`);
  ok(Math.round(r.depositNoNameTotal) === 18185, "no-name subtotal");
  ok(Math.round(r.otherIncomeDepositTotal) === 16000, "Other Income deposits informational, not flagged rows");
  ok(r.invoiceCount === 20 && r.invoiceTotal === 10000, "invoice context");
  ok(r.depositRows[0].amount === 15309, "sorted largest first");
}

// 2. Pure cash business: deposits are how they record sales — NOT flagged.
{
  const detail: PLDetailRow[] = [
    row({ txn_id: "d1", txn_type: "Deposit", amount: 900, account: "Carpet Cleaning Revenue", name: "Walk-in" }),
    row({ txn_id: "d2", txn_type: "Deposit", amount: 700, account: "Carpet Cleaning Revenue" }),
  ];
  const r = analyzeDepositsToIncome(detail, ACCOUNTS);
  ok(!r.flagged, "cash-only book not flagged");
  ok(r.depositCount === 2, "still reports the deposits for review");
  ok(/no meaningful invoicing/i.test(r.reason), "reason explains why");
}

// 3. Immaterial: under the floor.
{
  const detail: PLDetailRow[] = [
    ...Array.from({ length: 15 }, (_, i) => row({ txn_id: `i${i}`, amount: 400 })),
    row({ txn_id: "d", txn_type: "Deposit", amount: DEPOSIT_TO_INCOME_FLOOR - 1, account: "Carpet Cleaning Revenue" }),
  ];
  const r = analyzeDepositsToIncome(detail, ACCOUNTS);
  ok(!r.flagged, "under-floor not flagged");
}

// 4. Clean book: invoices only.
{
  const detail: PLDetailRow[] = Array.from({ length: 30 }, (_, i) => row({ txn_id: `i${i}` }));
  const r = analyzeDepositsToIncome(detail, ACCOUNTS);
  ok(!r.flagged && r.depositCount === 0, "clean book: nothing to report");
}

// 5. Deleted income account seen only via the P&L income section fallback.
{
  const detail: PLDetailRow[] = [
    ...Array.from({ length: 12 }, (_, i) => row({ txn_id: `i${i}`, amount: 800 })),
    row({ txn_id: "d", txn_type: "Deposit", amount: 1200, account: "Old Revenue (deleted)" }),
  ];
  const r = analyzeDepositsToIncome(detail, ACCOUNTS, ["Old Revenue (deleted)"]);
  ok(r.depositCount === 1 && r.flagged, "income-section fallback catches deleted accounts");
}

// 6. Sales Receipts count as invoice-like (they ARE the sale), not deposits.
{
  const detail: PLDetailRow[] = [
    ...Array.from({ length: 12 }, (_, i) => row({ txn_id: `sr${i}`, txn_type: "Sales Receipt", amount: 300 })),
    row({ txn_id: "d", txn_type: "Deposit", amount: 2000, account: "Carpet Cleaning Revenue" }),
  ];
  const r = analyzeDepositsToIncome(detail, ACCOUNTS);
  ok(r.invoiceCount === 12, "sales receipts are invoice-like");
  ok(r.flagged, "SR-driven book with revenue deposits flags");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
