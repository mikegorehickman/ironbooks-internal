import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { removeDuplicateTxn } from "@/lib/dup-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/dup-findings/[id]
 *   { action: "remove", txn_id }  → snapshot + void/delete that copy in QBO
 *   { action: "keep", note? }     → not a duplicate; never resurfaces
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { action?: string; txn_id?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { data: finding } = await (service as any).from("dup_findings").select("*").eq("id", id).single();
  if (!finding) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  if (finding.status !== "open") return NextResponse.json({ ok: true, already_resolved: true });

  if (body.action === "keep") {
    await (service as any)
      .from("dup_findings")
      .update({
        status: "kept",
        resolved_by: user.id,
        resolved_at: new Date().toISOString(),
        note: body.note ? `${finding.note} · kept: ${String(body.note).slice(0, 300)}` : finding.note,
      })
      .eq("id", id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "remove") {
    if (!body.txn_id) return NextResponse.json({ error: "txn_id is required" }, { status: 400 });
    const result = await removeDuplicateTxn(service, finding, body.txn_id, user.id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, method: result.method });
  }

  return NextResponse.json({ error: "action must be remove or keep" }, { status: 400 });
}
