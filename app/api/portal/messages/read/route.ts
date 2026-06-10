import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/messages/read
 *
 * Marks every unread bookkeeper→client communication as read for the
 * authed client. Fired when the client opens /portal/messages — clears
 * the unread badge in the portal nav.
 */
export async function POST() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  const service = createServiceSupabase();
  const { error } = await (service as any)
    .from("client_communications")
    .update({ read_at: new Date().toISOString(), read_by: ctx.userId })
    .eq("client_link_id", ctx.clientLinkId)
    .eq("direction", "to_client")
    .is("read_at", null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
