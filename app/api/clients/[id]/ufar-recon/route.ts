import { NextResponse } from "next/server";
import { after } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { runUfArRecon } from "@/lib/ufar-recon";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * UF/AR Reconciler runs for one client.
 *   POST  {}                        → start a run (background; returns run_id)
 *   GET                             → latest run (status + summary + report)
 *   PATCH { run_id, step, done }    → toggle a clearing-plan step
 */
async function gate() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { service, userId: user.id };
}

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate();
  if ("error" in g) return g.error;
  const { service, userId } = g;

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", id)
    .single();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "Client has no QBO connection" }, { status: 400 });

  const { data: run, error } = await (service as any)
    .from("ufar_recon_runs")
    .insert({ client_link_id: id, status: "running", window_days: 365, created_by: userId })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: `Run migration 108 first — ${error.message}` }, { status: 500 });

  after(async () => {
    const svc = createServiceSupabase() as any;
    try {
      const result = await runUfArRecon(svc, client as any);
      await svc
        .from("ufar_recon_runs")
        .update({
          status: "complete",
          summary: result.summary,
          report: result.report,
          completed_at: new Date().toISOString(),
        })
        .eq("id", (run as any).id);
      try {
        await svc.from("audit_log").insert({
          event_type: "ufar_recon_completed",
          user_id: userId,
          request_payload: { client_link_id: id, run_id: (run as any).id, ...result.summary },
        });
      } catch {}
    } catch (e: any) {
      await svc
        .from("ufar_recon_runs")
        .update({ status: "failed", error_message: String(e?.message || e).slice(0, 500) })
        .eq("id", (run as any).id);
    }
  });

  return NextResponse.json({ started: true, run_id: (run as any).id });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate();
  if ("error" in g) return g.error;
  const { data: run } = await (g.service as any)
    .from("ufar_recon_runs")
    .select("*")
    .eq("client_link_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({ ok: true, run: run || null });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await context.params;
  const g = await gate();
  if ("error" in g) return g.error;
  let body: { run_id?: string; step?: number; done?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.run_id || typeof body.step !== "number") {
    return NextResponse.json({ error: "run_id and step are required" }, { status: 400 });
  }
  const { data: run } = await (g.service as any)
    .from("ufar_recon_runs")
    .select("steps_done")
    .eq("id", body.run_id)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const done = new Set<number>((run.steps_done as number[]) || []);
  body.done === false ? done.delete(body.step) : done.add(body.step);
  await (g.service as any)
    .from("ufar_recon_runs")
    .update({ steps_done: [...done].sort((a, b) => a - b) })
    .eq("id", body.run_id);
  return NextResponse.json({ ok: true, steps_done: [...done] });
}
