import Anthropic from "@anthropic-ai/sdk";
import { fetchProfitAndLoss, fetchPLDetailAll } from "./qbo-reports";
import { fetchBalancesAsOf } from "./qbo-balance-sheet";
import { fetchAllAccounts } from "./qbo";
import { getValidToken } from "./qbo-reclass";

/**
 * Canadian year-end tax export.
 *
 * One GIFI mapping (master_coa.gifi_code, migration 109) drives everything:
 *  - T2: GIFI rows for S125 (P&L) + S100 (balance sheet) — ProFile, TaxPrep,
 *    CanTax, and TaxCycle all import GIFI, so one export covers the suite.
 *  - T1: a T2125 sheet — its expense lines use the same code numbers, so we
 *    group by code and label with the T2125 line names. Meals get the 50%
 *    limitation computed; vehicle/home-office add-backs take a business-use
 *    percentage in the UI.
 *  - T5018: subcontractor totals per vendor from the subcontract accounts
 *    (code 8360) — the slips are just vendor + total.
 *
 * Everything is REVIEW MATERIAL for the preparer, not a filing.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const T2125_LINES: Record<string, string> = {
  "8521": "Advertising",
  "8523": "Meals & entertainment (50% limit applied)",
  "8590": "Bad debts",
  "8690": "Insurance",
  "8710": "Interest & bank charges",
  "8760": "Business taxes, licences & memberships",
  "8811": "Office expenses / supplies",
  "8860": "Professional fees",
  "8861": "Legal fees",
  "8862": "Accounting fees",
  "8910": "Rent",
  "9060": "Salaries, wages & benefits",
  "8620": "Commissions",
  "8622": "Employee benefits",
  "9180": "Property taxes",
  "9200": "Travel",
  "9220": "Utilities",
  "9281": "Motor vehicle expenses",
  "8670": "Capital cost allowance (from books: depreciation)",
  "9270": "Other expenses",
};
const COGS_CODES = new Set(["8320", "8340", "8360", "8450", "8457"]);

export interface TaxExportResult {
  period: { start: string; end: string };
  gifi_pl: Array<{ code: string; label: string; amount: number }>;
  gifi_bs: Array<{ code: string; label: string; amount: number }>;
  unmapped: Array<{ account: string; amount: number; where: "pl" | "bs" }>;
  t2125: {
    gross: number;
    cogs: number;
    gross_profit: number;
    expenses: Array<{ code: string; label: string; amount: number }>;
    meals_total: number;
    meals_disallowed: number;
    vehicle_total: number;
    net_before_adjustments: number;
  };
  t5018: Array<{ vendor: string; total: number }>;
}

export async function buildTaxExport(
  service: any,
  clientLink: { id: string; qbo_realm_id: string; jurisdiction?: string | null },
  period: { start: string; end: string }
): Promise<TaxExportResult> {
  const token = await getValidToken(clientLink.id, service);

  const [pl, balances, accounts, detail, { data: master }] = await Promise.all([
    fetchProfitAndLoss(clientLink.qbo_realm_id, token, period.start, period.end, "Accrual"),
    fetchBalancesAsOf(clientLink.qbo_realm_id, token, period.end),
    fetchAllAccounts(clientLink.qbo_realm_id, token),
    fetchPLDetailAll(clientLink.qbo_realm_id, token, period.start, period.end, "Accrual"),
    service.from("master_coa").select("account_name, gifi_code"),
  ]);

  const gifiByName = new Map<string, string | null>(
    ((master as any[]) || []).map((m) => [String(m.account_name).toLowerCase().trim(), m.gifi_code || null])
  );
  const lookup = (name: string) => gifiByName.get(name.toLowerCase().trim()) ?? null;

  // ── P&L → GIFI (roll up by code) ──
  const plByCode = new Map<string, number>();
  const unmapped: TaxExportResult["unmapped"] = [];
  for (const item of pl.lineItems || []) {
    if (!item.amount) continue;
    const code = lookup(item.label);
    if (!code) {
      unmapped.push({ account: item.label, amount: item.amount, where: "pl" });
      continue;
    }
    plByCode.set(code, (plByCode.get(code) || 0) + item.amount);
  }

  // ── Balance sheet → GIFI ──
  const nameById = new Map(accounts.map((a: any) => [String(a.Id), a.Name]));
  const bsByCode = new Map<string, number>();
  for (const [acctId, bal] of balances) {
    if (!bal) continue;
    const name = nameById.get(String(acctId)) || String(acctId);
    const code = lookup(name);
    if (!code) {
      unmapped.push({ account: name, amount: bal, where: "bs" });
      continue;
    }
    bsByCode.set(code, (bsByCode.get(code) || 0) + bal);
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const gifiRows = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([code, amount]) => ({ code, label: T2125_LINES[code] || `GIFI ${code}`, amount: round(amount) }))
      .sort((a, b) => a.code.localeCompare(b.code));

  // ── T2125 sheet ──
  const mealsTotal = round(plByCode.get("8523") || 0);
  const expenses = [...plByCode.entries()]
    .filter(([code]) => !COGS_CODES.has(code) && code >= "8500" && code < "9400")
    .map(([code, amount]) => ({
      code,
      label: T2125_LINES[code] || "Other expenses (9270)",
      amount: round(code === "8523" ? amount * 0.5 : amount),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const cogs = round(
    [...plByCode.entries()].filter(([c]) => COGS_CODES.has(c)).reduce((s, [, v]) => s + v, 0)
  );
  const gross = round(plByCode.get("8000") || pl.totalIncome || 0);

  // ── T5018: subcontractor totals per vendor (code 8360 accounts) ──
  const subAccounts = new Set(
    ((master as any[]) || [])
      .filter((m) => m.gifi_code === "8360")
      .map((m) => String(m.account_name).toLowerCase().trim())
  );
  const byVendor = new Map<string, number>();
  for (const row of detail) {
    if (!subAccounts.has(String(row.account || "").toLowerCase().trim())) continue;
    const vendor = row.name || "Unknown vendor";
    byVendor.set(vendor, (byVendor.get(vendor) || 0) + Math.abs(row.amount || 0));
  }
  const t5018 = [...byVendor.entries()]
    .map(([vendor, total]) => ({ vendor, total: round(total) }))
    .sort((a, b) => b.total - a.total);

  return {
    period,
    gifi_pl: gifiRows(plByCode),
    gifi_bs: gifiRows(bsByCode),
    unmapped,
    t2125: {
      gross,
      cogs,
      gross_profit: round(gross - cogs),
      expenses,
      meals_total: mealsTotal,
      meals_disallowed: round(mealsTotal * 0.5),
      vehicle_total: round(plByCode.get("9281") || 0),
      net_before_adjustments: round(
        gross - cogs - expenses.reduce((s, e) => s + e.amount, 0)
      ),
    },
    t5018,
  };
}

/**
 * Jurisdiction tax notes for the fiscal year — Claude with web search
 * restricted to GOVERNMENT domains only, cached per (jurisdiction, region,
 * fiscal year) in tax_jurisdiction_notes.
 */
export async function getTaxNotes(
  service: any,
  jurisdiction: string,
  region: string | null,
  fiscalYear: number
): Promise<{ notes: any[]; cached: boolean }> {
  const reg = region || "";
  const { data: cached } = await service
    .from("tax_jurisdiction_notes")
    .select("notes")
    .eq("jurisdiction", jurisdiction)
    .eq("region", reg)
    .eq("fiscal_year", fiscalYear)
    .maybeSingle();
  if (cached?.notes) return { notes: cached.notes, cached: true };

  const domains =
    jurisdiction === "CA"
      ? ["canada.ca", "cra-arc.gc.ca", "alberta.ca", "ontario.ca", "gov.bc.ca", "saskatchewan.ca", "gov.mb.ca", "quebec.ca", "revenuquebec.ca", "gnb.ca", "novascotia.ca"]
      : ["irs.gov", "sba.gov"];

  const resp = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 3000,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 6,
        allowed_domains: domains,
      } as any,
    ],
    system: `You research year-end tax considerations for a small PAINTING CONTRACTOR business. Jurisdiction: ${jurisdiction}${reg ? ` (${reg})` : ""}, fiscal year ${fiscalYear}. Search ONLY the allowed government domains. Find items applicable to THIS fiscal year: rate changes, small-business deduction thresholds, CCA/immediate-expensing rules, vehicle deduction limits (per-km and lease/interest caps), home-office rules, T5018 reporting requirements, and any trades/construction-specific measures. Return STRICT JSON only: [{"title": "short", "detail": "2-3 sentences with the specific number/rule and the fiscal-year applicability", "source_url": "the government URL you verified", "applies_to": "T1|T2|T5018|both"}]. Max 8 items. Only include items you verified at a government URL; never invent rates.`,
    messages: [{ role: "user", content: `Fiscal year ${fiscalYear} year-end tax notes, please.` }],
  });

  let notes: any[] = [];
  try {
    const text = resp.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    notes = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  } catch {
    notes = [];
  }
  if (notes.length) {
    try {
      await service.from("tax_jurisdiction_notes").insert({
        jurisdiction, region: reg, fiscal_year: fiscalYear, notes,
      });
    } catch {}
  }
  return { notes, cached: false };
}
