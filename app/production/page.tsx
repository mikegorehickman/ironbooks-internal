import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { redirect as nav } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /production — month-by-month board for graduated (production) clients.
 *
 * Columns: Not Started / In Progress / Stuck / Waiting on Client, plus a
 * Done strip. Clients arrive here when a manager approves their cleanup
 * sign-off. Each month is tracked separately — finish May and the client
 * shows up in June's Not Started.
 */
export default async function ProductionPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // The monthly close now drives production work: one bucket per client per
  // month, with the 7-stage checklist and a single obvious next action. Kept as
  // a redirect rather than two competing boards — the previous version tracked a
  // generic status with the month held in the bookkeeper's head.
  nav("/monthly-close");
}
