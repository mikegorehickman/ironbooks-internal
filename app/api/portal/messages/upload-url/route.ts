import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import {
  CLIENT_UPLOADS_BUCKET,
  sanitizeFilename,
  validateUploadMeta,
} from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/messages/upload-url
 *
 * Issues a signed upload URL so the browser uploads statement files
 * DIRECTLY to Supabase Storage — bypassing Vercel's ~4.5MB request body
 * limit (bank statement PDFs regularly exceed it). Flow:
 *
 *   1. Browser POSTs { name, size, content_type } here
 *   2. We validate (extension allowlist, 25MB cap) and mint a signed
 *      upload token scoped to ONE path under the client's own folder
 *   3. Browser calls supabase.storage.uploadToSignedUrl(path, token, file)
 *   4. The resulting path is attached to a message via POST /api/portal/messages
 *
 * Path scheme: <client_link_id>/<yyyy-mm>/<ts>-<sanitized-name>
 * The client_link_id prefix is the ownership boundary enforced at
 * message-attach and download time.
 */
export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  let meta: { name?: string; size?: number; content_type?: string };
  try {
    meta = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const validationError = validateUploadMeta(meta);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const safeName = sanitizeFilename(meta.name!);
  const yyyymm = new Date().toISOString().slice(0, 7);
  const path = `${ctx.clientLinkId}/${yyyymm}/${Date.now()}-${safeName}`;

  const service = createServiceSupabase();
  const { data, error } = await service.storage
    .from(CLIENT_UPLOADS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    console.error(`[portal/upload-url] signed URL failed for ${path}:`, error?.message);
    return NextResponse.json(
      { error: "Could not prepare the upload — try again in a moment" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    path: data.path,
    token: data.token,
    name: safeName,
    size: meta.size,
    content_type: meta.content_type || "",
  });
}
