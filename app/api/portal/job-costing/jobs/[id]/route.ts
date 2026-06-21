import { NextResponse } from "next/server";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { jobBodyToRow, rowToJob } from "../route";

export const dynamic = "force-dynamic";

/** PATCH = update a job; DELETE = remove it. Both ownership-checked against
 *  the signed-in client (a client can only touch their own jobs). */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  const body = await request.json().catch(() => ({} as any));
  const row = jobBodyToRow(body);
  if (!row.job_name) return NextResponse.json({ error: "Job name is required" }, { status: 400 });

  const service = createServiceSupabase();
  const { data, error } = await (service as any)
    .from("jc_jobs")
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_link_id", ctx.clientLinkId)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job: rowToJob(data) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  const service = createServiceSupabase();
  const { error } = await (service as any)
    .from("jc_jobs")
    .delete()
    .eq("id", id)
    .eq("client_link_id", ctx.clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
