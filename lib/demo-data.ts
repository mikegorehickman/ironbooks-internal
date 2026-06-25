/**
 * Synthetic demo data for the "Test Painting Co" demo client.
 *
 * SNAP's financials are normally fetched live from QuickBooks. The demo client
 * has the sentinel realm id `DEMO` (no real QBO connection); the low-level QBO
 * fetchers detect that realm and return the data below instead of calling
 * Intuit — so both the bookkeeper profile and the client portal render a
 * believable painting-contractor P&L, Balance Sheet, account list, and bank
 * balances with no QBO, and nothing expires.
 *
 * Numbers mirror a real small painting contractor (≈$35–42k/mo revenue). The
 * by-month view shows 3 complete months; single-period fetches return whichever
 * of those months the requested range lands on (so primary-vs-comparison deltas
 * look real). Type-only imports keep this free of runtime import cycles.
 */
import type { QBOAccount } from "./qbo";
import type { ProfitLossData } from "./qbo-reports";
import type { ProfitLossByMonth, PLByMonthBlock } from "./qbo-pl-by-month";
import type { OpenInvoice } from "./qbo-balance-sheet";
import type { QBOCustomerLite } from "./qbo-stripe-recon";

export const DEMO_REALM = "DEMO";
export function isDemoRealm(realm?: string | null): boolean {
  return realm === DEMO_REALM;
}

export const DEMO_MONTH_LABELS = ["Mar 2026", "Apr 2026", "May 2026"] as const;

// ─── A/R: open invoices + customers ─────────────────────────────────────────
// Powers the "Who owes you" page for the demo client (and the AI follow-up
// email feature). Due dates are RELATIVE to today so the aging buckets +
// "days overdue" always read realistically whenever the demo is shown.

/** A date `days` from today (negative = past), as YYYY-MM-DD. */
function demoDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

interface DemoARRow {
  cid: string;
  customer: string;
  email: string;
  phone: string;
  doc: string;
  amount: number;
  /** Days until due — negative means overdue by that many days. */
  dueInDays: number;
}

// A believable small-painter A/R book: a couple of slow property-management
// clients, one badly overdue realty group, and a few recent invoices — spread
// across the aging buckets so the page + follow-up email demo look real.
const DEMO_AR_ROWS: DemoARRow[] = [
  { cid: "DEMO-CUST-1", customer: "Maple Ridge Property Mgmt", email: "ap@mapleridgepm.com", phone: "(604) 555-0142", doc: "1042", amount: 4200, dueInDays: -75 },
  { cid: "DEMO-CUST-1", customer: "Maple Ridge Property Mgmt", email: "ap@mapleridgepm.com", phone: "(604) 555-0142", doc: "1058", amount: 2800, dueInDays: -40 },
  { cid: "DEMO-CUST-2", customer: "Westside Realty Group", email: "billing@westsiderealty.com", phone: "(604) 555-0188", doc: "0996", amount: 6500, dueInDays: -120 },
  { cid: "DEMO-CUST-3", customer: "Bryant Custom Homes", email: "office@bryanthomes.com", phone: "(778) 555-0119", doc: "1051", amount: 3400, dueInDays: -45 },
  { cid: "DEMO-CUST-4", customer: "Hillcrest HOA", email: "board@hillcresthoa.org", phone: "(604) 555-0163", doc: "1067", amount: 1950, dueInDays: -15 },
  { cid: "DEMO-CUST-5", customer: "Greenfield Dental", email: "admin@greenfielddental.ca", phone: "(250) 555-0177", doc: "1071", amount: 875, dueInDays: -8 },
  { cid: "DEMO-CUST-6", customer: "Lakeshore Café", email: "hello@lakeshorecafe.ca", phone: "(250) 555-0150", doc: "1074", amount: 1200, dueInDays: 10 },
];

/** Synthetic open A/R invoices (net-30 terms → txn_date 30d before due). */
export function demoOpenInvoices(): OpenInvoice[] {
  return DEMO_AR_ROWS.map((r, i) => ({
    qbo_invoice_id: `DEMO-INV-${1000 + i}`,
    doc_number: r.doc,
    customer_id: r.cid,
    customer_name: r.customer,
    txn_date: demoDateOffset(r.dueInDays - 30),
    due_date: demoDateOffset(r.dueInDays),
    total_amount: r.amount,
    balance: r.amount,
    currency: "USD",
  }));
}

/** Synthetic customers (email + phone) so the page shows contact info + mailto. */
export function demoCustomers(): QBOCustomerLite[] {
  const seen = new Map<string, DemoARRow>();
  for (const r of DEMO_AR_ROWS) if (!seen.has(r.cid)) seen.set(r.cid, r);
  return Array.from(seen.values()).map((r) => ({
    id: r.cid,
    display_name: r.customer,
    primary_email: r.email,
    primary_phone: r.phone,
  }));
}

type Section = "income" | "cogs" | "expense";

interface PLAcct {
  id: string;
  name: string;
  section: Section;
  accountType: string;
  accountSubType: string;
  m: [number, number, number]; // Mar, Apr, May
}

// P&L accounts (account ids are stable so PL line items link to the COA rows).
const PL_ACCOUNTS: PLAcct[] = [
  { id: "d-inc-1", name: "Painting Revenue", section: "income", accountType: "Income", accountSubType: "SalesOfProductIncome", m: [42000, 38000, 35000] },

  { id: "d-cogs-1", name: "Paint & Materials", section: "cogs", accountType: "Cost of Goods Sold", accountSubType: "SuppliesMaterialsCogs", m: [16000, 15000, 16000] },
  { id: "d-cogs-2", name: "Direct Field Labor – Painting", section: "cogs", accountType: "Cost of Goods Sold", accountSubType: "CostOfLabor", m: [8000, 7500, 7446] },
  { id: "d-cogs-3", name: "Subcontractors – Painting", section: "cogs", accountType: "Cost of Goods Sold", accountSubType: "CostOfLaborCos", m: [4500, 4000, 4235] },
  { id: "d-cogs-4", name: "Employer Payroll Taxes – Field", section: "cogs", accountType: "Cost of Goods Sold", accountSubType: "CostOfLabor", m: [2000, 1850, 1901] },
  { id: "d-cogs-5", name: "Small Tools", section: "cogs", accountType: "Cost of Goods Sold", accountSubType: "SuppliesMaterialsCogs", m: [300, 280, 273] },
  { id: "d-cogs-6", name: "Job Supplies", section: "cogs", accountType: "Cost of Goods Sold", accountSubType: "SuppliesMaterialsCogs", m: [200, 190, 183] },

  { id: "d-exp-1", name: "Vehicle Expenses:Fuel – Admin & Sales Vehicles", section: "expense", accountType: "Expense", accountSubType: "Auto", m: [1500, 1400, 1444] },
  { id: "d-exp-2", name: "Advertising and Promotion:Online Advertising – Google Ads / Social Media Marketing", section: "expense", accountType: "Expense", accountSubType: "Advertising", m: [1400, 1350, 1375] },
  { id: "d-exp-3", name: "General Liability Insurance", section: "expense", accountType: "Expense", accountSubType: "Insurance", m: [1299, 1299, 1299] },
  { id: "d-exp-4", name: "Vehicle Expenses:Insurance - Vehicle", section: "expense", accountType: "Expense", accountSubType: "Insurance", m: [1128, 1128, 1128] },
  { id: "d-exp-5", name: "Office & Admin:Software Subscriptions", section: "expense", accountType: "Expense", accountSubType: "OfficeGeneralAdministrativeExpenses", m: [800, 790, 794] },
  { id: "d-exp-6", name: "Professional Fees:Accounting & Bookkeeping", section: "expense", accountType: "Expense", accountSubType: "LegalProfessionalFees", m: [650, 650, 650] },
  { id: "d-exp-7", name: "Bank Charges and Interest:Interest Expense", section: "expense", accountType: "Expense", accountSubType: "OtherMiscellaneousServiceCost", m: [360, 350, 349] },
  { id: "d-exp-8", name: "Advertising and Promotion:Meals (50% deductible)", section: "expense", accountType: "Expense", accountSubType: "EntertainmentMeals", m: [340, 330, 333] },
  { id: "d-exp-9", name: "Office & Admin:Telephone & Internet", section: "expense", accountType: "Expense", accountSubType: "Utilities", m: [320, 310, 309] },
];

interface BSAcct {
  id: string;
  name: string;
  classification: "Asset" | "Liability" | "Equity";
  accountType: string;
  accountSubType: string;
  balance: number;
}

// Balance-sheet accounts (drive the BS tab + Bank Balances tab).
const BS_ACCOUNTS: BSAcct[] = [
  { id: "d-bank-1", name: "Operating Checking", classification: "Asset", accountType: "Bank", accountSubType: "Checking", balance: 45230 },
  { id: "d-bank-2", name: "Payroll Checking", classification: "Asset", accountType: "Bank", accountSubType: "Checking", balance: 12180 },
  { id: "d-ar", name: "Accounts Receivable", classification: "Asset", accountType: "Accounts Receivable", accountSubType: "AccountsReceivable", balance: 18450 },
  { id: "d-fa-1", name: "Vehicles", classification: "Asset", accountType: "Fixed Asset", accountSubType: "Vehicles", balance: 35000 },
  { id: "d-fa-2", name: "Equipment", classification: "Asset", accountType: "Fixed Asset", accountSubType: "MachineryAndEquipment", balance: 8200 },
  { id: "d-cc", name: "Company Visa", classification: "Liability", accountType: "Credit Card", accountSubType: "CreditCard", balance: 3520 },
  { id: "d-ap", name: "Accounts Payable", classification: "Liability", accountType: "Accounts Payable", accountSubType: "AccountsPayable", balance: 6980 },
  { id: "d-loan", name: "Vehicle Loan", classification: "Liability", accountType: "Long Term Liability", accountSubType: "NotesPayable", balance: 21750 },
  { id: "d-eq-1", name: "Owner's Equity", classification: "Equity", accountType: "Equity", accountSubType: "OwnersEquity", balance: 50000 },
  { id: "d-eq-2", name: "Retained Earnings", classification: "Equity", accountType: "Equity", accountSubType: "RetainedEarnings", balance: 36810 },
];

const MEAL_PATTERN = /meals|entertainment/i;
const groupOf = (s: Section) =>
  s === "income" ? "Income" : s === "cogs" ? "Cost of Goods Sold" : "Expenses";

/** Map a requested period start to one of the 3 demo months; default latest. */
function monthIndexFor(start?: string): number {
  if (!start) return 2;
  const d = new Date(`${start}T00:00:00`);
  const m = d.getMonth(); // 0-11
  if (m === 2) return 0; // Mar
  if (m === 3) return 1; // Apr
  if (m === 4) return 2; // May
  return 2;
}

function makeQboAccount(p: {
  id: string;
  name: string;
  accountType: string;
  accountSubType: string;
  classification: string;
  balance: number;
}): QBOAccount {
  return {
    Id: p.id,
    Name: p.name,
    FullyQualifiedName: p.name,
    AccountType: p.accountType,
    AccountSubType: p.accountSubType,
    Classification: p.classification,
    Active: true,
    SubAccount: false,
    CurrentBalance: p.balance,
    CurrentBalanceWithSubAccounts: p.balance,
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    MetaData: { CreateTime: "2025-01-01T00:00:00Z", LastUpdatedTime: "2026-05-31T00:00:00Z" },
  };
}

/** Full COA (P&L + Balance Sheet accounts) — powers fetchAllAccounts. */
export function demoAccounts(): QBOAccount[] {
  const pl = PL_ACCOUNTS.map((a) =>
    makeQboAccount({
      id: a.id,
      name: a.name,
      accountType: a.accountType,
      accountSubType: a.accountSubType,
      classification: a.section === "income" ? "Revenue" : "Expense",
      balance: a.m[2],
    })
  );
  const bs = BS_ACCOUNTS.map((a) =>
    makeQboAccount({
      id: a.id,
      name: a.name,
      accountType: a.accountType,
      accountSubType: a.accountSubType,
      classification: a.classification,
      balance: a.balance,
    })
  );
  return [...pl, ...bs];
}

/** As-of balances keyed by account id — powers fetchBalancesAsOf (BS tab). */
export function demoBalancesAsOf(): Map<string, number> {
  return new Map(BS_ACCOUNTS.map((a) => [a.id, a.balance]));
}

/** Single-period P&L for the requested range (picks the closest demo month). */
export function demoProfitAndLoss(start?: string): ProfitLossData {
  const idx = monthIndexFor(start);
  const lineItems = PL_ACCOUNTS.map((a) => ({
    label: a.name,
    amount: a.m[idx],
    group: groupOf(a.section),
    account_id: a.id,
  }));
  const totalIncome = PL_ACCOUNTS.filter((a) => a.section === "income").reduce((s, a) => s + a.m[idx], 0);
  const totalExpenses = PL_ACCOUNTS.filter((a) => a.section !== "income").reduce((s, a) => s + a.m[idx], 0);
  const mealsAccounts = lineItems.filter((l) => MEAL_PATTERN.test(l.label));
  return {
    totalIncome,
    totalExpenses,
    netIncome: totalIncome - totalExpenses,
    cogs: 0,
    grossProfit: totalIncome,
    mealsExpense: mealsAccounts.reduce((s, a) => s + Math.abs(a.amount), 0),
    mealsAccounts,
    lineItems,
  };
}

/** Month-by-month P&L (3 complete months) — powers the comparative view. */
export function demoProfitAndLossByMonth(): ProfitLossByMonth {
  const months = DEMO_MONTH_LABELS.map((title) => ({ title }));
  const sum = (sec: Section, i: number) =>
    PL_ACCOUNTS.filter((a) => a.section === sec).reduce((s, a) => s + a.m[i], 0);

  const sectionBlock = (title: string, sec: Section, totalLabel: string): PLByMonthBlock => ({
    kind: "section",
    title,
    totalLabel,
    accounts: PL_ACCOUNTS.filter((a) => a.section === sec).map((a) => ({
      name: a.name,
      values: [a.m[0], a.m[1], a.m[2]],
      total: a.m[0] + a.m[1] + a.m[2],
    })),
    totals: [0, 1, 2].map((i) => sum(sec, i)),
    total: [0, 1, 2].reduce((s, i) => s + sum(sec, i), 0),
  });

  const grossPerMonth = [0, 1, 2].map((i) => sum("income", i) - sum("cogs", i));
  const netPerMonth = [0, 1, 2].map((i) => sum("income", i) - sum("cogs", i) - sum("expense", i));

  const blocks: PLByMonthBlock[] = [
    sectionBlock("Income", "income", "Total Income"),
    sectionBlock("Cost of Goods Sold", "cogs", "Total Cost of Goods Sold"),
    { kind: "summary", title: "Gross Profit", values: grossPerMonth, total: grossPerMonth.reduce((a, b) => a + b, 0) },
    sectionBlock("Expenses", "expense", "Total Expenses"),
    { kind: "summary", title: "Net Income", values: netPerMonth, total: netPerMonth.reduce((a, b) => a + b, 0) },
  ];
  return { months, blocks };
}
