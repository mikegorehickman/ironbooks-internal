import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /onboarding — retired in the re-IA. Onboarding now lives on the unified
 * Clients table (stage = onboarding) and inside the client workspace, instead
 * of a standalone GHL-style board. This stub keeps old links/bookmarks working.
 * (The former OnboardingBoard component + lead queries are preserved in git
 * history if we ever want a lead-only pre-client view back.)
 */
export default async function OnboardingPage() {
  redirect("/clients?stage=onboarding");
}
