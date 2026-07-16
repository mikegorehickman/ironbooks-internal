/**
 * P&L display categories — the master-COA-derived taxonomy the client portal
 * groups expenses under (Mike, 2026-07-16: "see all marketing in one
 * category totaled with %, all administrative expenses totaled with %").
 *
 * Why keyword-based rather than the client's QBO parent accounts: real client
 * charts sprawl (Blessent alone: "Marketing" + "Marketing Tools" + "Online
 * Advertising – Google Ads / Social Media Marketing" as three separate
 * accounts; "Job Supplies" + "Job Supplies & Materials" + "Paint & Materials"
 * as three). Grouping by the master category collapses all of those into one
 * line with a subtotal + %, TODAY — without waiting for the chart to be
 * standardized. The categories mirror the master COA parents.
 *
 * Order matters: the first matching rule wins, so specific patterns precede
 * generic ones. Anything unmatched falls to "Other".
 */

export interface PlCategory {
  key: string;
  label: string;
  match: RegExp;
}

// Operating-expense (below gross profit) categories, in P&L display order.
const OPERATING_CATEGORIES: PlCategory[] = [
  { key: "payroll", label: "Payroll & Wages", match: /\b(payroll|wages?|salar(y|ies)|cpp|\bei\b|employee benefit|benefits|commission|bonus|retirement|rrsp|401k|superannuation)\b/i },
  { key: "marketing", label: "Marketing & Advertising", match: /\b(marketing|advertis\w*|\bads?\b|promo\w*|seo|google ads|facebook|meta ads|instagram|social media|lead ?gen\w*|\bleads?\b|yelp|angi|homeadvisor|home advisor|signage|branding|website|web ?design|mailer|flyer|print( ads)?|billboard|sponsor\w*)\b/i },
  { key: "professional", label: "Professional Services", match: /\b(accounting|accountant|bookkeep\w*|legal|attorney|lawyer|consult\w*|professional fees?|advisor|tax prep\w*)\b/i },
  { key: "insurance", label: "Insurance", match: /\b(insurance|liability|wsib|workers'? comp\w*|bond(ing)?)\b/i },
  { key: "vehicle", label: "Vehicle & Fuel", match: /\b(vehicle|fuel|gasoline|\bgas\b|mileage|auto\w*|truck|registration|licen[cs]e plate)\b/i },
  { key: "travel_meals", label: "Travel & Meals", match: /\b(meals?|travel|lodging|hotel|airfare|flights?|entertain\w*|per ?diem)\b/i },
  { key: "rent_utilities", label: "Rent & Utilities", match: /\b(rent|lease|utilit\w*|hydro|electric\w*|\bwater\b|\bgas &|internet|phone|cell\w*|mobile|telecom\w*|storage)\b/i },
  { key: "office_admin", label: "Office & Admin", match: /\b(office|admin\w*|bank (charge|fee)s?|service charge|software|subscription|saas|dues|memberships?|postage|shipping|stationery|supplies|quickbooks|zoom|microsoft|dropbox|merchant fee|processing fee|credit card fee)\b/i },
  { key: "owner_pay", label: "Owner Pay & Draws", match: /\b(owner|draws?|distribution|shareholder|dividend|member draw)\b/i },
  { key: "taxes_licenses", label: "Taxes & Licenses", match: /\b(tax(es)?|licen[cs]e|permits?|franchise fee|regulatory)\b/i },
  { key: "education", label: "Education & Training", match: /\b(education|training|courses?|certificat\w*|professional development|conference|seminar|workshop)\b/i },
  { key: "repairs", label: "Repairs & Maintenance", match: /\b(repairs?|maintenance)\b/i },
  { key: "interest_fees", label: "Interest & Finance Charges", match: /\b(interest|finance charge|late fee|penalt\w*|nsf)\b/i },
];

// Cost-of-goods (variable / direct job cost) categories.
const COGS_CATEGORIES: PlCategory[] = [
  { key: "cogs_subs", label: "Subcontractors", match: /\bsub-?contractor\w*\b/i },
  { key: "cogs_labor", label: "Direct Labor", match: /\b(labou?r|field (labou?r|crew|wages?)|crew|installer)\b/i },
  { key: "cogs_materials", label: "Materials & Supplies", match: /\b(material\w*|supplies|paint\w*|primer|coating|lumber|hardware|small tools?|sundr\w*|job supply|consumables?)\b/i },
  { key: "cogs_equipment", label: "Equipment Rental", match: /\b(equipment rental|equip\.? rental|rental|scaffold\w*|lift rental)\b/i },
  { key: "cogs_other", label: "Other Job Costs", match: /\b(permit\w*|disposal|dump( fees?)?|uniforms?|job costs?|direct fuel|waste)\b/i },
];

/**
 * Categorize a single P&L expense line by its account name.
 * @param isCogs  true for lines already in the variable/COGS bucket.
 * Returns a stable {key,label}; unmatched lines land in "Other …".
 */
export function categorizeExpenseLine(label: string, isCogs: boolean): { key: string; label: string } {
  const name = label || "";
  const set = isCogs ? COGS_CATEGORIES : OPERATING_CATEGORIES;
  for (const c of set) {
    if (c.match.test(name)) return { key: c.key, label: c.label };
  }
  return isCogs
    ? { key: "cogs_other", label: "Other Job Costs" }
    : { key: "other_operating", label: "Other Operating Expenses" };
}

/** Display order for operating categories (unmatched "Other" always last). */
export function operatingCategoryOrder(key: string): number {
  const i = OPERATING_CATEGORIES.findIndex((c) => c.key === key);
  return i === -1 ? OPERATING_CATEGORIES.length + 1 : i;
}
export function cogsCategoryOrder(key: string): number {
  const i = COGS_CATEGORIES.findIndex((c) => c.key === key);
  return i === -1 ? COGS_CATEGORIES.length + 1 : i;
}
