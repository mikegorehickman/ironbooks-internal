import { tryResolvePortalContext } from "@/lib/portal-context";
import { getJobCosting } from "@/lib/qbo-job-costing";
import { PortalErrorState } from "../error-state";
import { JobCostingClient } from "./job-costing-client";

/**
 * Job Costing — per-job profitability for painting contractors. Defaults to
 * year-to-date; the client component re-fetches other ranges on demand via
 * /api/portal/job-costing. Uses class tracking when on (cleanest job costing),
 * otherwise falls back to customer-level P&L and prompts the client to enable
 * class tracking.
 */
export const dynamic = "force-dynamic";

export default async function JobCostingPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const start = `${now.getFullYear()}-01-01`;
  const end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  let initial = null;
  try {
    initial = await getJobCosting(ctx.qboRealmId, ctx.accessToken, start, end);
  } catch {
    initial = null;
  }

  return <JobCostingClient initial={initial} initialStart={start} initialEnd={end} />;
}
