import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * GET /api/clients/[id]/ucpi?status=   (READ-ONLY)
 *
 * The client's UCPI resolution questions (from ucpi_resolutions, migration 144)
 * — one per (customer, statement period), with the two answers + resolution
 * state. Feeds the bookkeeper review and the portal question card. Owner
 * bookkeeper or admin/lead.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const status = new URL(request.url).searchParams.get("status");
  let query = (service as any)
    .from("ucpi_resolutions")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .order("unapplied_amount", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ client_link_id: clientLinkId, count: (rows || []).length, items: rows || [] });
}
