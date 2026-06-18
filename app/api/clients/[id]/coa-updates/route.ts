import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getNewCoaCategoriesForClient } from "@/lib/coa-updates";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/coa-updates
 *
 * Read-only. Returns the master-COA categories that were added AFTER this
 * client was last cleaned — the ones to re-offer at month-end. Drives the
 * "new categories available" banner. Auth: assigned bookkeeper or admin/lead.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, jurisdiction, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { lastCleanedAt, categories } = await getNewCoaCategoriesForClient(service, {
    clientLinkId,
    jurisdiction: (client as any).jurisdiction,
  });

  return NextResponse.json({
    count: categories.length,
    last_cleaned_at: lastCleanedAt,
    jurisdiction: (client as any).jurisdiction,
    categories,
  });
}
