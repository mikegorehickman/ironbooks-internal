// Client-safe billing tier constants + types.
//
// These live in their own module (NOT page.tsx) so the client component
// `billing-client.tsx` can import them without dragging the server-only
// page.tsx (which pulls in lib/supabase → next/headers) into the client
// bundle. page.tsx re-exports these for back-compat.

export type ServiceTier = "insight" | "discipline" | "vision" | "scale";

export interface TierConfig {
  key: ServiceTier;
  name: string;
  tagline: string;
  monthlyFee: number | null;
  firstMonthFee: number | null;
  revenueCap: string;
  /** Numeric form of revenueCap: the top of this tier's monthly-revenue band,
   *  in cents. A client whose sustained monthly revenue exceeds this has
   *  outgrown the tier (see lib/upgrade-signals.ts). null = no upper bound
   *  (scale). Insight's $25K/mo cap == the $300K/yr run-rate upgrade line. */
  monthlyRevenueCapCents: number | null;
  onboardingCall: string;
  color: string;
}

export const TIERS: TierConfig[] = [
  {
    key: "insight",
    name: "Tier 1 – Insight",
    tagline: "Getting your books clean and in order.",
    monthlyFee: 247,
    firstMonthFee: 500,
    revenueCap: "Up to $25K/mo",
    monthlyRevenueCapCents: 25_000_00,
    onboardingCall: "1:1 (30 min)",
    color: "teal",
  },
  {
    key: "discipline",
    name: "Tier 2 – Discipline",
    tagline: "Monthly reporting, coaching, and accountability.",
    monthlyFee: 497,
    firstMonthFee: 750,
    revenueCap: "Up to $85K/mo",
    monthlyRevenueCapCents: 85_000_00,
    onboardingCall: "1:1 (30 min)",
    color: "blue",
  },
  {
    key: "vision",
    name: "Tier 3 – Vision",
    tagline: "Full financial partnership for growing businesses.",
    monthlyFee: 797,
    firstMonthFee: 1500,
    revenueCap: "Up to $250K/mo",
    monthlyRevenueCapCents: 250_000_00,
    onboardingCall: "1:1 (60 min)",
    color: "violet",
  },
  {
    key: "scale",
    name: "Tier 4 – Scale",
    tagline: "Enterprise bookkeeping for high-revenue operations.",
    monthlyFee: null,
    firstMonthFee: null,
    revenueCap: "Above $3M/yr",
    monthlyRevenueCapCents: null,
    onboardingCall: "Custom",
    color: "navy",
  },
];

export const INCLUDED_FEATURES = [
  "Accrual or cash-basis bookkeeping",
  "Bank and credit card reconciliations",
  "Monthly Profit & Loss and Balance Sheet",
  "AI-generated monthly summaries, human-reviewed",
  "Unlimited Ironbooks app & AI tool access",
  "Weekly group coaching calls (optional)",
  "Email support and monthly action video",
  "1:1 onboarding call with your bookkeeping coach",
];
