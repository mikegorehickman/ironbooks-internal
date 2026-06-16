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
