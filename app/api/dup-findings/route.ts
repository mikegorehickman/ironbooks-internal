import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** GET /api/dup-findings?client_link_id=… — open duplicate findings,
 *  newest first, enriched with client names. No param = all clients. */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const clientId = new URL(request.url).searchParams.get("client_link_id");
  let q = (service as any)
    .from("dup_findings")
    .select("*")
    .eq("status", "open")
    .order("tier", { ascending: true }) // certain < likely < possible alphabetically ✓
    .order("detected_at", { ascending: false })
    .limit(300);
  if (clientId) q = q.eq("client_link_id", clientId);
  const { data: rows, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = [...new Set(((rows as any[]) || []).map((r) => r.client_link_id))];
  const { data: cls } = ids.length
    ? await service.from("client_links").select("id, client_name").in("id", ids)
    : { data: [] };
  const nameById = new Map(((cls as any[]) || []).map((c) => [c.id, c.client_name]));
  return NextResponse.json({
    ok: true,
    findings: ((rows as any[]) || []).map((r) => ({ ...r, client_name: nameById.get(r.client_link_id) || "Unknown" })),
  });
}
