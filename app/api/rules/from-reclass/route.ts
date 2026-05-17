import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { reclass_job_id, client_link_id, selected_vendors, overrides } = body as {
    reclass_job_id: string;
    client_link_id: string;
    selected_vendors: string[];
    overrides?: Record<string, { id: string; name: string }>;
  };

  if (!reclass_job_id || !client_link_id || !selected_vendors?.length) {
    return NextResponse.json(
      { error: "reclass_job_id, client_link_id, and selected_vendors are required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount"
    )
    .eq("reclass_job_id", reclass_job_id)
    .in("decision", ["auto_approve", "approved"])
    .not("vendor_name", "is", null);

  type ReclassRow = {
    vendor_name: string | null;
    vendor_pattern_normalized: string | null;
    to_account_id: string;
    to_account_name: string | null;
    bookkeeper_override_target_id: string | null;
    bookkeeper_override_target_name: string | null;
    transaction_amount: number | null;
  };

  const groupMap = new Map<
    string,
    {
      vendorDisplay: string;
      targetCounts: Map<string, { id: string; name: string; count: number }>;
      txCount: number;
      totalAmount: number;
      sampleDescriptions: string[];
    }
  >();

  for (const row of (rows || []) as ReclassRow[]) {
    const groupKey = row.vendor_pattern_normalized || row.vendor_name || "";
    if (!groupKey) continue;

    const targetId = row.bookkeeper_override_target_id || row.to_account_id;
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    if (!targetName) continue;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        vendorDisplay: row.vendor_name || groupKey,
        targetCounts: new Map(),
        txCount: 0,
        totalAmount: 0,
        sampleDescriptions: [],
      });
    }

    const group = groupMap.get(groupKey)!;
    group.txCount += 1;
    group.totalAmount += row.transaction_amount || 0;

    if (row.vendor_name && group.sampleDescriptions.length < 3) {
      if (!group.sampleDescriptions.includes(row.vendor_name)) {
        group.sampleDescriptions.push(row.vendor_name);
      }
    }

    const existing = group.targetCounts.get(targetId);
    if (existing) {
      existing.count += 1;
    } else {
      group.targetCounts.set(targetId, { id: targetId, name: targetName, count: 1 });
    }
  }

  const selectedSet = new Set(selected_vendors);
  const rulesToUpsert: Array<{
    client_link_id: string;
    vendor_pattern: string;
    match_type: string;
    target_account_name: string;
    status: string;
    ai_confidence: null;
    ai_reasoning: null;
    requires_approval: boolean;
    sample_descriptions: string[];
    transaction_count: number;
    total_amount: number;
    created_by: string;
    pushed_to_qbo: boolean;
  }> = [];

  for (const [vendorPattern, group] of groupMap.entries()) {
    if (!selectedSet.has(vendorPattern)) continue;

    // Prefer the bookkeeper's override (set in the dropdown); fall back to
    // the most-frequent AI-picked target.
    let bestTarget = { id: "", name: "" };
    const override = overrides?.[vendorPattern];
    if (override?.name) {
      bestTarget = { id: override.id || "", name: override.name };
    } else {
      let bestCount = 0;
      for (const t of group.targetCounts.values()) {
        if (t.count > bestCount) {
          bestCount = t.count;
          bestTarget = { id: t.id, name: t.name };
        }
      }
    }
    if (!bestTarget.name) continue;

    rulesToUpsert.push({
      client_link_id,
      vendor_pattern: vendorPattern,
      match_type: "CONTAINS",
      target_account_name: bestTarget.name,
      status: "approved",
      ai_confidence: null,
      ai_reasoning: null,
      requires_approval: false,
      sample_descriptions: group.sampleDescriptions,
      transaction_count: group.txCount,
      total_amount: group.totalAmount,
      created_by: "reclass",
      pushed_to_qbo: false,
    });
  }

  if (rulesToUpsert.length === 0) {
    return NextResponse.json({ created: 0, rules: [] });
  }

  const { data: upserted, error } = await service
    .from("bank_rules")
    .upsert(rulesToUpsert, { onConflict: "client_link_id,vendor_pattern" })
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ created: upserted?.length ?? rulesToUpsert.length, rules: upserted ?? [] });
}
