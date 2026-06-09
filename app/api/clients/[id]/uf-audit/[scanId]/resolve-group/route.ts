import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/uf-audit/[scanId]/resolve-group
 *
 * Apply a resolution to every orphan in a customer group (or to a specific
 * set of payment IDs). Doesn't touch QBO — just records the decision so
 * finalize can act on it.
 *
 * Body:
 *   {
 *     customer_qbo_id?: string,             // group selector (one of these)
 *     customer_name?: string,                // or this
 *     payment_ids?: string[],               // or explicit ID list
 *     resolution: "owner_draw" | "write_off" | "duplicate_recategorize" |
 *                 "ask_client" | "manual_investigation" | "pending",
 *     target_account_id?: string,           // required for JE-creating resolutions
 *     target_account_name?: string,
 *     notes?: string,
 *   }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: scan } = await service
    .from("uf_audit_scans" as any)
    .select("id, client_link_id, status")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  if ((scan as any).status === "finalized") {
    return NextResponse.json({ error: "Scan already finalized" }, { status: 409 });
  }

  const body = await request.json();
  const resolution = String(body.resolution || "");
  const validResolutions = [
    "owner_draw",
    "write_off",
    "duplicate_recategorize",
    "void_duplicate",
    "create_deposit",
    "ask_client",
    "manual_investigation",
    "pending",
  ];
  if (!validResolutions.includes(resolution)) {
    return NextResponse.json(
      { error: `resolution must be one of ${validResolutions.join(", ")}` },
      { status: 400 }
    );
  }

  // For JE-creating resolutions, target account is required at finalize-time;
  // we let it be empty here so the UI can collect it inline. But owner_draw
  // and write_off SHOULD have one — surface a soft hint via notes.
  const targetAccountId = body.target_account_id ? String(body.target_account_id) : null;
  const targetAccountName = body.target_account_name ? String(body.target_account_name) : null;
  const notes = body.notes ? String(body.notes) : null;

  // create_deposit needs a target BANK account to sweep UF into.
  const depositBankAccountId = body.deposit_bank_account_id
    ? String(body.deposit_bank_account_id)
    : null;
  const depositBankAccountName = body.deposit_bank_account_name
    ? String(body.deposit_bank_account_name)
    : null;
  if (resolution === "create_deposit" && !depositBankAccountId) {
    return NextResponse.json(
      { error: "create_deposit requires deposit_bank_account_id (the bank to sweep UF into)" },
      { status: 400 }
    );
  }

  // Build the selector
  let q = service
    .from("uf_audit_items" as any)
    .update({
      resolution,
      resolution_target_account_id: targetAccountId,
      resolution_target_account_name: targetAccountName,
      deposit_bank_account_id: depositBankAccountId,
      deposit_bank_account_name: depositBankAccountName,
      resolution_notes: notes,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    } as any)
    .eq("scan_id", scanId)
    .eq("classification", "orphan")
    .neq("resolution", "executed");

  if (Array.isArray(body.payment_ids) && body.payment_ids.length > 0) {
    q = q.in("qbo_payment_id", body.payment_ids.map(String));
  } else if (body.customer_qbo_id) {
    q = q.eq("customer_qbo_id", String(body.customer_qbo_id));
  } else if (body.customer_name) {
    q = q.eq("customer_name", String(body.customer_name));
  } else {
    return NextResponse.json(
      { error: "Provide one of customer_qbo_id, customer_name, or payment_ids[]" },
      { status: 400 }
    );
  }

  const { error, count } = await (q as any).select("id", { count: "exact", head: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updated: count ?? 0 });
}
