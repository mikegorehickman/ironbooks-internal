import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getAttentionMap, attentionMapToJson } from "@/lib/client-attention-state";

export const dynamic = "force-dynamic";

/**
 * GET /api/attention — the badge feed for every board surface.
 *
 * Returns only clients that HAVE an attention state (escalated, billing,
 * BS owed, disconnected, stuck job), keyed by client_link_id. Boards fetch
 * this once on mount alongside their own data and hand each card its state.
 */
export async function GET() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper", "viewer"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const map = await getAttentionMap(service as any);
  const clients = attentionMapToJson(map);

  // Billing states are revenue ops — senior signal. Bookkeepers can't act
  // on UNBILLED/PAST DUE, so don't broadcast them; "hold" stays visible to
  // everyone because it changes how the client is serviced.
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    for (const id of Object.keys(clients)) {
      if (clients[id].billing && clients[id].billing !== "hold") clients[id].billing = null;
    }
  }

  return NextResponse.json({ ok: true, clients });
}
