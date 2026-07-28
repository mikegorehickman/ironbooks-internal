import { resolvePortalContextAllowNoQbo } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { LearnClient } from "./learn-client";

export const dynamic = "force-dynamic";

/**
 * Learn — LMS reading from the learning_resources table.
 *
 * Bookkeepers populate the table via SQL (or a future admin UI). The
 * portal Learn page just renders is_active rows in sort_order, grouped
 * by category. Per-user progress tracking deferred — the v1 just shows
 * everyone the full library and lets them pick.
 */
export default async function LearnPage() {
  const ctxResult = await resolvePortalContextAllowNoQbo();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;

  const service = createServiceSupabase();
  const { data: resourcesRaw } = await service
    .from("learning_resources" as any)
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  const resources = (resourcesRaw as any[]) || [];

  return <LearnClient resources={resources} />;
}
