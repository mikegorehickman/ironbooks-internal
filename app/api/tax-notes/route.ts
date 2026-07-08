import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getTaxNotes } from "@/lib/tax-export";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/tax-notes?client_link_id=…&fy=2026 — cached per
 *  (jurisdiction, region, fiscal year); government sources only. */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_link_id");
  const fy = parseInt(url.searchParams.get("fy") || "", 10);
  if (!clientId || !fy) return NextResponse.json({ error: "client_link_id and fy are required" }, { status: 400 });
  const { data: client } = await service
    .from("client_links")
    .select("jurisdiction, state_province")
    .eq("id", clientId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  try {
    const r = await getTaxNotes(service as any, client.jurisdiction || "CA", (client as any).state_province || null, fy);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Notes failed" }, { status: 502 });
  }
}
