import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { PortalErrorState } from "../error-state";
import { CoachingCallBooking } from "./coaching-call-client";

export const dynamic = "force-dynamic";

/**
 * Dedicated portal page for booking a paid coaching call. Same resolution path
 * as the rest of the portal (tryResolvePortalContext) + the same coach/price
 * config the billing card uses, so the two stay consistent.
 */
export default async function CoachingCallPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    if (ctxResult.code === "no_session") redirect("/auth/login");
    return <PortalErrorState code={ctxResult.code as any} />;
  }
  const { ctx } = ctxResult;
  const service = createServiceSupabase();

  const { data: cl } = await service
    .from("client_links")
    .select("jurisdiction")
    .eq("id", ctx.clientLinkId)
    .single();
  const jurisdiction = ((cl as any)?.jurisdiction as string | null) || "US";

  let coaches: { coach_key: string; coach_name: string }[] = [];
  try {
    const { data } = await (service as any)
      .from("coaching_call_settings")
      .select("coach_key, coach_name")
      .eq("active", true)
      .order("sort_order");
    coaches = (data as any[]) || [];
  } catch {
    coaches = [];
  }

  const priceConfigured = !!(jurisdiction === "CA"
    ? process.env.STRIPE_COACHING_PRICE_CAD
    : process.env.STRIPE_COACHING_PRICE_USD);
  const enabled = coaches.length > 0 && priceConfigured;
  const fallbackLink =
    jurisdiction === "CA"
      ? process.env.STRIPE_COACHING_CALL_PAYMENT_LINK_CAD || null
      : process.env.STRIPE_COACHING_CALL_PAYMENT_LINK_USD || null;

  return (
    <CoachingCallBooking
      coaches={coaches}
      enabled={enabled}
      fallbackLink={fallbackLink}
      impersonating={ctx.impersonating}
    />
  );
}
