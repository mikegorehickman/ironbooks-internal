import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { planUcpiResolution, type UcpiItem, type UcpiOpenInvoice } from "@/lib/ucpi-resolution";

/**
 * POST /api/clients/[id]/ucpi/[resolutionId]/answer
 *   { collected: boolean, kind?: "earned" | "deposit", answered_by?: string }
 *
 * Records the client's two answers on a UCPI question and computes the
 * resolution plan (planUcpiResolution) — but does NOT touch QBO yet; the
 * executor (apply / void / move-to-Customer-Deposits) is a separate step.
 * Owner bookkeeper or admin/lead (the portal-client path answers here too in
 * Phase 3, passing answered_by:"client").
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; resolutionId: string }> }
) {
  const { id: clientLinkId, resolutionId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  if (typeof body.collected !== "boolean") {
    return NextResponse.json({ error: "collected (boolean) is required" }, { status: 400 });
  }
  const kind = body.kind === "earned" || body.kind === "deposit" ? body.kind : undefined;
  if (body.collected && !kind) {
    return NextResponse.json({ error: "kind ('earned'|'deposit') is required when collected is true" }, { status: 400 });
  }

  const { data: row, error: rowErr } = await (service as any)
    .from("ucpi_resolutions")
    .select("*")
    .eq("id", resolutionId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (rowErr || !row) return NextResponse.json({ error: "UCPI question not found" }, { status: 404 });
  if (row.status === "resolved") {
    return NextResponse.json({ error: "Already resolved — nothing to answer" }, { status: 409 });
  }

  // Reconstruct the item from the stored snapshot (planner only reads the open
  // invoices + amount) and compute the plan.
  const openInvoices: UcpiOpenInvoice[] = Array.isArray(row.open_invoices) ? row.open_invoices : [];
  const item: UcpiItem = {
    customer: row.customer ?? null,
    customer_id: row.customer_id ?? null,
    unapplied_total: Number(row.unapplied_amount) || 0,
    payments: [],
    open_invoices: openInvoices,
    has_open_invoices: openInvoices.length > 0,
  };
  const plan = planUcpiResolution(item, { collected: body.collected, kind });

  const { data: updated, error: upErr } = await (service as any)
    .from("ucpi_resolutions")
    .update({
      collected: body.collected,
      kind: kind ?? null,
      resolution: plan.action,
      resolution_detail: { reason: plan.reason, target_invoices: plan.target_invoices ?? null },
      status: "answered",
      answered_at: new Date().toISOString(),
      answered_by: typeof body.answered_by === "string" ? body.answered_by : user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", resolutionId)
    .select("*")
    .single();
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, plan, resolution: updated });
}
