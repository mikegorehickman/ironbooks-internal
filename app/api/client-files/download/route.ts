import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * GET /api/client-files/download?path=<storage path>
 *
 * Single download gateway for the private client-uploads bucket, used by
 * BOTH sides of the messages thread:
 *
 *   - Internal staff (admin/lead/bookkeeper/viewer): any path
 *   - Portal clients: only paths under their own client_link_id prefix
 *
 * Mints a 2-minute signed URL and redirects. The bucket is private, so
 * this route (service role) is the only way files come out.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path") || "";
  // Path shape: <uuid>/<yyyy-mm>/<ts>-<name>. Reject traversal early.
  if (!path || path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  const isInternal = ["admin", "lead", "bookkeeper", "viewer"].includes(role);

  if (!isInternal) {
    // Portal client (or impersonating admin) — must own the path prefix
    const ctxResult = await tryResolvePortalContext();
    if (!ctxResult.ok || !path.startsWith(`${ctxResult.ctx.clientLinkId}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Force a download disposition with the original filename (the storage
  // key's trailing segment after the timestamp prefix).
  const basename = path.split("/").pop() || "file";
  const originalName = basename.replace(/^\d{10,}-/, "");

  const { data, error } = await service.storage
    .from(CLIENT_UPLOADS_BUCKET)
    .createSignedUrl(path, 120, { download: originalName });
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  return NextResponse.redirect(data.signedUrl);
}
