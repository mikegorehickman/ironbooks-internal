import { NextResponse } from "next/server";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { getJobCosting } from "@/lib/qbo-job-costing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/portal/job-costing?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Per-job profitability (revenue, direct costs, gross margin) for the signed-in
 * client. Defaults to year-to-date when the range is missing/invalid. Scoped to
 * the portal user's own QBO via resolvePortalContext.
 */
export async function GET(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  const sp = new URL(request.url).searchParams;
  let start = sp.get("start") || "";
  let end = sp.get("end") || "";
  if (!ISO.test(start) || !ISO.test(end) || start > end) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    start = `${now.getFullYear()}-01-01`;
    end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  try {
    const data = await getJobCosting(ctx.qboRealmId, ctx.accessToken, start, end);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json(
      { error: `Couldn't load job costing — ${err?.message || "unknown error"}` },
      { status: 500 }
    );
  }
}
