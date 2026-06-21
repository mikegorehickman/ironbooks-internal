import { NextResponse } from "next/server";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const clamp = (v: any, lo: number, hi: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
};

/** PATCH the client's job-costing goals + labor burden. Values are fractions
 *  (0–1). Upserts a single per-client settings row. */
export async function PATCH(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  const body = await request.json().catch(() => ({} as any));
  const row = {
    client_link_id: ctx.clientLinkId,
    goal_paint_pct: clamp(body.goalPaintPct, 0, 1),
    goal_labor_pct: clamp(body.goalLaborPct, 0, 1),
    burden_pct: clamp(body.burdenPct, 0, 1),
    updated_at: new Date().toISOString(),
  };

  const service = createServiceSupabase();
  const { error } = await (service as any)
    .from("jc_settings")
    .upsert(row, { onConflict: "client_link_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    settings: {
      goalPaintPct: row.goal_paint_pct,
      goalLaborPct: row.goal_labor_pct,
      burdenPct: row.burden_pct,
    },
  });
}
