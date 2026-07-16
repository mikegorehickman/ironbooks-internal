import type { PeriodBounds } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export interface PublishedMonthEndPackage {
  id: string;
  periodYear: number;
  periodMonth: number;
  periodStart: string;
  periodEnd: string;
  label: string;
  aiSummary: string;
  plSnapshot: Record<string, unknown>;
  bsSnapshot: Record<string, unknown>;
  arApSnapshot: Record<string, unknown>;
  portalPublishedAt: string;
  /** This month was delivered while the client was in the DRAFT stage —
   *  the portal shows the DRAFT banner + gut-check panel. */
  sentAsDraft: boolean;
}

export async function fetchPublishedPackage(
  service: Service,
  clientLinkId: string,
  periodYear?: number,
  periodMonth?: number
): Promise<PublishedMonthEndPackage | null> {
  let query = service
    .from("month_end_packages")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .eq("status", "sent")
    .not("portal_published_at", "is", null);

  if (periodYear && periodMonth) {
    query = query.eq("period_year", periodYear).eq("period_month", periodMonth);
  } else {
    query = query.order("period_year", { ascending: false }).order("period_month", { ascending: false });
  }

  const { data } = await query.limit(1).maybeSingle();
  if (!data) return null;

  const start = new Date(data.period_year, data.period_month - 1, 1);
  const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return {
    id: data.id,
    periodYear: data.period_year,
    periodMonth: data.period_month,
    periodStart: data.period_start,
    periodEnd: data.period_end,
    label,
    aiSummary: data.ai_summary || "",
    plSnapshot: data.pl_snapshot || {},
    bsSnapshot: data.bs_snapshot || {},
    arApSnapshot: data.ar_ap_snapshot || {},
    portalPublishedAt: data.portal_published_at,
    sentAsDraft: data.sent_as_draft === true,
  };
}

export async function getUnseenPackageBanner(
  service: Service,
  clientLinkId: string,
  userId: string
): Promise<{ packageId: string; label: string; periodYear: number; periodMonth: number } | null> {
  const pkg = await fetchPublishedPackage(service, clientLinkId);
  if (!pkg) return null;

  const { data: cu } = await service
    .from("client_users")
    .select("last_seen_package_id")
    .eq("user_id", userId)
    .eq("client_link_id", clientLinkId)
    .maybeSingle();

  if (cu?.last_seen_package_id === pkg.id) return null;

  return {
    packageId: pkg.id,
    label: pkg.label,
    periodYear: pkg.periodYear,
    periodMonth: pkg.periodMonth,
  };
}
