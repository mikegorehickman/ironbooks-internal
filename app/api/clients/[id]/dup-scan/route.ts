import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { scanClientForDuplicates } from "@/lib/dup-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/clients/[id]/dup-scan — run the duplicate scan for one client
 *  (read-only against QBO; findings land in dup_findings). */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", id)
    .single();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "Client has no QBO connection" }, { status: 400 });
  try {
    const result = await scanClientForDuplicates(service, client as any);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Scan failed" }, { status: 502 });
  }
}
