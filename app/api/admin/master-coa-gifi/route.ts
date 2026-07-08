import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function gate() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { service };
}

/** GET — every master-COA account with its GIFI code (mapping editor). */
export async function GET() {
  const g = await gate();
  if ("error" in g) return g.error;
  const { data, error } = await (g.service as any)
    .from("master_coa")
    .select("id, account_name, section, jurisdiction, gifi_code, is_parent")
    .order("section")
    .order("account_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, accounts: data || [] });
}

/** PATCH { id, gifi_code } — set/clear one account's code. */
export async function PATCH(request: Request) {
  const g = await gate();
  if ("error" in g) return g.error;
  let body: { id?: string; gifi_code?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const code = (body.gifi_code || "").trim();
  if (code && !/^\d{4}$/.test(code)) {
    return NextResponse.json({ error: "GIFI codes are 4 digits" }, { status: 400 });
  }
  const { error } = await (g.service as any)
    .from("master_coa")
    .update({ gifi_code: code || null })
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
