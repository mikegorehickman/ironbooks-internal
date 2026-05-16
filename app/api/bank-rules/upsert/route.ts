import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/bank-rules/upsert
 *
 * Idempotent "remember this categorization" call.
 * Invoked from the reclass review UI when a bookkeeper picks (or confirms)
 * the target account for a vendor — we persist a bank_rules row so the same
 * vendor auto-categorizes on the next reclass run.
 *
 * Skipped client-side for ask_client decisions (peer payments are unique).
 *
 * Body:
 *  {
 *    client_link_id: string,
 *    vendor_pattern: string,
 *    target_account_name: string
 *  }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { client_link_id, vendor_pattern, target_account_name } = body;

  if (!client_link_id || !vendor_pattern || !target_account_name) {
    return NextResponse.json(
      { error: "client_link_id, vendor_pattern, and target_account_name are all required" },
      { status: 400 }
    );
  }

  // Normalize vendor pattern so "SHERWIN-WILLIAMS #4521" and "Sherwin Williams Co"
  // create the same rule.
  const normalized = vendor_pattern
    .toUpperCase()
    .replace(/#\d+/g, "")           // strip store numbers
    .replace(/[^A-Z0-9 ]/g, " ")    // strip punctuation
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return NextResponse.json({ error: "Vendor pattern is empty after normalization" }, { status: 400 });
  }

  const service = createServiceSupabase();

  // Check if a rule for this (client, vendor) already exists.
  const { data: existing } = await service
    .from("bank_rules")
    .select("id, target_account_name")
    .eq("client_link_id", client_link_id)
    .eq("vendor_pattern", normalized)
    .maybeSingle();

  if (existing) {
    // Update only if target changed
    if (existing.target_account_name !== target_account_name) {
      await service
        .from("bank_rules")
        .update({
          target_account_name,
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", existing.id);
    }
    return NextResponse.json({ updated: true, rule_id: existing.id });
  }

  // Create a new rule
  const { data: created, error } = await service
    .from("bank_rules")
    .insert({
      client_link_id,
      vendor_pattern: normalized,
      target_account_name,
      ai_confidence: 1.0,        // bookkeeper-confirmed = full confidence
      ai_reasoning: "Confirmed by bookkeeper during transaction reclassification.",
      match_type: "CONTAINS",
      requires_approval: false,
      status: "approved",
      created_by: user.id,
      pushed_to_qbo: false,
    } as any)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ created: true, rule: created });
}
