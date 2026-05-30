import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { parseExternalInvoiceFile, type ExternalSource } from "@/lib/external-invoices/parse";

/**
 * Endpoints for managing external invoice imports (Jobber, DripJobs).
 *
 * POST   /api/clients/[id]/external-invoices
 *   multipart/form-data with:
 *     file:   the .xlsx (Jobber) or .csv (DripJobs)
 *     source: "jobber" | "dripjobs" (optional — auto-detected from file magic)
 *
 *   Replaces any existing import for (client, source). Returns parse
 *   summary so the upload card on BS Cleanup can show counts immediately.
 *
 * GET    /api/clients/[id]/external-invoices
 *   Returns the current import state: which sources have been uploaded,
 *   when, by whom, and row counts.
 *
 * DELETE /api/clients/[id]/external-invoices?source=jobber
 *   Clears a specific source's import. Cascades to external_invoice_rows.
 */

export const runtime = "nodejs"; // xlsx parsing needs Node, not Edge
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  const sourceHint = (form.get("source") as string | null)?.toLowerCase() || null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required (multipart/form-data)" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "file is empty" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "file too large (max 10MB)" }, { status: 413 });
  }

  const buffer = await file.arrayBuffer();
  let parsed;
  try {
    parsed = parseExternalInvoiceFile(file.name, buffer);
  } catch (err: any) {
    return NextResponse.json({ error: `Parse failed: ${err.message}` }, { status: 400 });
  }

  // sourceHint overrides auto-detect when present
  const source: ExternalSource =
    sourceHint === "jobber" || sourceHint === "dripjobs" ? sourceHint : parsed.source;

  if (parsed.rows.length === 0) {
    return NextResponse.json(
      { error: "Parsed 0 rows from file. Confirm columns match Jobber's or DripJobs's invoice export format." },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // ON CONFLICT (client_link_id, source) → replace: delete the prior import
  // (cascade clears its rows) before inserting the new one.
  await (service as any)
    .from("external_invoice_imports")
    .delete()
    .eq("client_link_id", clientLinkId)
    .eq("source", source);

  const { data: importRow, error: impErr } = await (service as any)
    .from("external_invoice_imports")
    .insert({
      client_link_id: clientLinkId,
      source,
      uploaded_by: user.id,
      filename: file.name,
      row_count: parsed.rows.length,
      invoice_count: parsed.invoice_count,
      parse_warnings: parsed.warnings as any,
    } as any)
    .select("id")
    .single();

  if (impErr || !importRow) {
    return NextResponse.json({ error: `Insert failed: ${impErr?.message || "no row"}` }, { status: 500 });
  }

  // Insert rows in chunks of 500 to stay under Supabase's per-request size cap
  const importId = (importRow as any).id as string;
  const dbRows = parsed.rows.map((r) => ({
    import_id: importId,
    client_link_id: clientLinkId,
    source,
    customer_name: r.customer_name,
    customer_name_normalized: r.customer_name_normalized,
    lineage_key: r.lineage_key,
    external_invoice_id: r.external_invoice_id,
    row_type: r.row_type,
    amount: r.amount,
    issue_date: r.issue_date,
    status: r.status,
    raw_row: r.raw_row as any,
  }));

  const CHUNK = 500;
  for (let i = 0; i < dbRows.length; i += CHUNK) {
    const slice = dbRows.slice(i, i + CHUNK);
    const { error: rErr } = await (service as any).from("external_invoice_rows").insert(slice as any);
    if (rErr) {
      // Roll back the parent import so we don't leave a half-loaded state
      await (service as any).from("external_invoice_imports").delete().eq("id", importId);
      return NextResponse.json(
        { error: `Row insert failed at offset ${i}: ${rErr.message}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    import_id: importId,
    source,
    filename: file.name,
    row_count: parsed.rows.length,
    invoice_count: parsed.invoice_count,
    warnings: parsed.warnings,
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: imports } = await (service as any)
    .from("external_invoice_imports")
    .select("*, users:uploaded_by(full_name)")
    .eq("client_link_id", clientLinkId)
    .order("uploaded_at", { ascending: false });

  return NextResponse.json({ imports: imports || [] });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const source = url.searchParams.get("source");
  if (!source || (source !== "jobber" && source !== "dripjobs")) {
    return NextResponse.json({ error: "source=jobber|dripjobs required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { error, count } = await (service as any)
    .from("external_invoice_imports")
    .delete({ count: "exact" })
    .eq("client_link_id", clientLinkId)
    .eq("source", source);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: count ?? 0 });
}
