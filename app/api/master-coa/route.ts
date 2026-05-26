import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/master-coa?jurisdiction=US|CA
 *
 * Returns all master COA accounts for a jurisdiction with usage stats.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const jurisdiction = searchParams.get("jurisdiction") || "US";

  if (!["US", "CA"].includes(jurisdiction)) {
    return NextResponse.json({ error: "Invalid jurisdiction" }, { status: 400 });
  }

  // Fetch accounts + usage in parallel
  const [accountsRes, usageRes] = await Promise.all([
    supabase
      .from("master_coa")
      .select("*")
      .eq("jurisdiction", jurisdiction)
      .order("sort_order"),
    supabase
      .from("master_coa_usage")
      .select("*")
      .eq("jurisdiction", jurisdiction),
  ]);

  if (accountsRes.error) {
    return NextResponse.json({ error: accountsRes.error.message }, { status: 500 });
  }

  const usageMap = new Map(
    (usageRes.data || []).map((u: any) => [u.id, u])
  );

  const accounts = (accountsRes.data || []).map((a) => ({
    ...a,
    usage: usageMap.get(a.id) || { times_used_in_cleanups: 0, times_used_in_rules: 0 },
  }));

  return NextResponse.json({ accounts, jurisdiction });
}

/**
 * POST /api/master-coa
 *
 * Create a new account. Lead/admin only (enforced by RLS).
 *
 * Body: full master_coa row (without id)
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // Required field validation — industry is REQUIRED to prevent silent
  // 'painters' default from the DB schema (caused chimney_sweepers and
  // every other non-painter industry to lose every new addition until
  // we caught it).
  const required = ["account_name", "jurisdiction", "industry", "qbo_account_type", "qbo_account_subtype", "section"];
  for (const field of required) {
    if (!body[field]) {
      return NextResponse.json({ error: `Missing required field: ${field}` }, { status: 400 });
    }
  }

  // Auto-assign sort_order: max for jurisdiction + 10
  if (!body.sort_order) {
    const { data: maxRow } = await supabase
      .from("master_coa")
      .select("sort_order")
      .eq("jurisdiction", body.jurisdiction)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    body.sort_order = (maxRow?.sort_order || 0) + 10;
  }

  const { data, error } = await supabase
    .from("master_coa")
    .insert(body)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ account: data });
}
