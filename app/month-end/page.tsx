import { redirect } from "next/navigation";

/**
 * /month-end → /production.
 *
 * The legacy fleet-wide Month-End Delivery command center was retired
 * (July 2026): its bulk send bypassed attestation, Books Reliability
 * verification, and monthly_rec_runs board sync. The close now lives on
 * the production board. The shared statement engine in lib/month-end/**
 * is unchanged.
 */
export default function MonthEndRedirect() {
  redirect("/production");
}
