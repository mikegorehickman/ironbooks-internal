import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/reclass/decisions/[id]
 *
 * Update a single reclassification row.
 *
 * Body:
 *   - decision: "approved" | "rejected" | "auto_approve" | "needs_review" | "flagged"
 *   - bookkeeper_override_target_id?: string  (admin/lead can override AI target)
 *   - bookkeeper_override_target_name?: string
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const updates: Record<string, any> = {};

  const validDecisions = [
    "approved",
    "rejected",
    "auto_approve",
    "needs_review",
    "flagged",
    "ask_client",
  ];
  if (body.decision !== undefined) {
    if (!validDecisions.includes(body.decision)) {
      return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
    }
    updates.decision = body.decision;
  }

  if (body.bookkeeper_override_target_id !== undefined) {
    updates.bookkeeper_override = true;
    updates.bookkeeper_override_target_id = body.bookkeeper_override_target_id;
    updates.bookkeeper_override_target_name = body.bookkeeper_override_target_name || null;
    updates.to_account_id = body.bookkeeper_override_target_id;
    updates.to_account_name = body.bookkeeper_override_target_name || null;
    if (!updates.decision) updates.decision = "approved";
  } else if (body.bookkeeper_override_target_name !== undefined) {
    // Name-only override from the new Map-to-Master dropdown — we don't have a
    // QBO target_id at the UI layer (it's resolved at execute time by name lookup).
    updates.bookkeeper_override = true;
    updates.bookkeeper_override_target_name = body.bookkeeper_override_target_name;
    updates.to_account_name = body.bookkeeper_override_target_name;
    if (!updates.decision) updates.decision = "approved";
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("reclassifications")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ reclassification: data });
}
