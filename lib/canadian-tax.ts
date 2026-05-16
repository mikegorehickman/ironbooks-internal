/**
 * Canadian sales tax rates by province/territory.
 *
 * Used by:
 *  - The new-job form (display tax rates when a Canadian province is selected)
 *  - The reclass executor (apply tax codes to QBO bank rules for Canadian clients)
 *
 * Rates current as of 2026. US clients skip tax entirely.
 */

export interface ProvinceTax {
  /** Two-letter Canadian province/territory code (ON, BC, etc.) */
  code: string;
  name: string;
  /** Display string: "13% HST", "5% GST + 7% PST", etc. */
  display: string;
  /** Individual rate components (decimal: 0.13 = 13%) */
  rates: {
    gst?: number;
    hst?: number;
    pst?: number;
    rst?: number;
    qst?: number;
  };
  /** Combined effective rate on tangible goods (decimal) */
  combined: number;
  /**
   * Tax that applies specifically to painting SERVICES (labor + repaints).
   * Painting is generally treated as a service, so PST/RST may not apply in
   * provinces where the provincial tax exempts most labor. Use this when
   * calculating tax on customer payments for service revenue.
   *
   * Sources (as of 2025):
   *  - BC: PST does not apply to most painting labor on existing real property
   *  - MB: RST does not apply to most labor services
   *  - SK: PST does apply to construction/painting services
   *  - QC: QST applies to services
   */
  serviceTax: {
    /** Combined rate on service revenue (decimal). */
    rate: number;
    /** Components that apply, e.g. ["HST"] or ["GST", "PST"] */
    components: string[];
    /** Bookkeeper-facing note about the rule for this province */
    notes?: string;
  };
}

export const CANADIAN_PROVINCES: ProvinceTax[] = [
  {
    code: "AB", name: "Alberta", display: "5% GST",
    rates: { gst: 0.05 }, combined: 0.05,
    serviceTax: { rate: 0.05, components: ["GST"] },
  },
  {
    code: "BC", name: "British Columbia", display: "5% GST + 7% PST",
    rates: { gst: 0.05, pst: 0.07 }, combined: 0.12,
    serviceTax: { rate: 0.05, components: ["GST"], notes: "PST does not apply to most painting labor on existing real property" },
  },
  {
    code: "MB", name: "Manitoba", display: "5% GST + 7% RST",
    rates: { gst: 0.05, rst: 0.07 }, combined: 0.12,
    serviceTax: { rate: 0.05, components: ["GST"], notes: "RST does not apply to most painting labor services" },
  },
  {
    code: "NB", name: "New Brunswick", display: "15% HST",
    rates: { hst: 0.15 }, combined: 0.15,
    serviceTax: { rate: 0.15, components: ["HST"] },
  },
  {
    code: "NL", name: "Newfoundland & Labrador", display: "15% HST",
    rates: { hst: 0.15 }, combined: 0.15,
    serviceTax: { rate: 0.15, components: ["HST"] },
  },
  {
    code: "NS", name: "Nova Scotia", display: "15% HST",
    rates: { hst: 0.15 }, combined: 0.15,
    serviceTax: { rate: 0.15, components: ["HST"] },
  },
  {
    code: "ON", name: "Ontario", display: "13% HST",
    rates: { hst: 0.13 }, combined: 0.13,
    serviceTax: { rate: 0.13, components: ["HST"] },
  },
  {
    code: "PE", name: "Prince Edward Island", display: "15% HST",
    rates: { hst: 0.15 }, combined: 0.15,
    serviceTax: { rate: 0.15, components: ["HST"] },
  },
  {
    code: "QC", name: "Quebec", display: "5% GST + 9.975% QST",
    rates: { gst: 0.05, qst: 0.09975 }, combined: 0.14975,
    serviceTax: { rate: 0.14975, components: ["GST", "QST"], notes: "QST applies to most services including painting" },
  },
  {
    code: "SK", name: "Saskatchewan", display: "5% GST + 6% PST",
    rates: { gst: 0.05, pst: 0.06 }, combined: 0.11,
    serviceTax: { rate: 0.11, components: ["GST", "PST"], notes: "Saskatchewan PST applies to construction & painting services" },
  },
  // Territories
  {
    code: "NT", name: "Northwest Territories", display: "5% GST",
    rates: { gst: 0.05 }, combined: 0.05,
    serviceTax: { rate: 0.05, components: ["GST"] },
  },
  {
    code: "NU", name: "Nunavut", display: "5% GST",
    rates: { gst: 0.05 }, combined: 0.05,
    serviceTax: { rate: 0.05, components: ["GST"] },
  },
  {
    code: "YT", name: "Yukon", display: "5% GST",
    rates: { gst: 0.05 }, combined: 0.05,
    serviceTax: { rate: 0.05, components: ["GST"] },
  },
];

/**
 * Get the tax rate that applies to painting service revenue for a province.
 * Use this when splitting customer payments into pre-tax revenue + tax collected.
 */
export function getServiceTaxRate(code: string | null | undefined): number {
  const p = getProvinceTax(code);
  return p?.serviceTax.rate ?? 0;
}

export function getProvinceTax(code: string | null | undefined): ProvinceTax | undefined {
  if (!code) return undefined;
  return CANADIAN_PROVINCES.find((p) => p.code === code.toUpperCase());
}
