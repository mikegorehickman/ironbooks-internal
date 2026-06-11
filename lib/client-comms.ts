/**
 * Client communications — shared types + helpers for the portal Messages
 * feature (migration 58 + the private `client-uploads` Storage bucket).
 *
 * Surfaces:
 *   - /portal/messages           client thread + statement uploads
 *   - /clients/[id]/messages     bookkeeper side of the same thread
 *   - /today inbound widget      unread client uploads across clients
 *
 * The client_communications table is not in the generated database
 * types yet — callers use `(service as any).from("client_communications")`
 * like other recently-added tables.
 */

export const CLIENT_UPLOADS_BUCKET = "client-uploads";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // keep in sync with bucket fileSizeLimit

/**
 * Extension allowlist for client uploads. Covers what painting
 * contractors actually send (bank/CC statements, receipts, exports):
 * documents, spreadsheets, images, bank-export formats, archives.
 * Blocks active content (html/svg/js/exe).
 */
export const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  "pdf", "csv", "xls", "xlsx", "txt",
  "png", "jpg", "jpeg", "heic", "webp",
  "ofx", "qfx", "qbo",
  "doc", "docx", "zip",
]);

export interface CommAttachment {
  /** Storage path inside CLIENT_UPLOADS_BUCKET: `<client_link_id>/<yyyy-mm>/<ts>-<name>` */
  path: string;
  name: string;
  size: number;
  content_type: string;
}

export interface ClientCommunication {
  id: string;
  client_link_id: string;
  sender_user_id: string | null;
  direction: "to_client" | "from_client";
  kind: "message" | "notification";
  subject: string | null;
  body: string | null;
  attachments: CommAttachment[];
  read_at: string | null;
  read_by: string | null;
  created_at: string;
  /** Enriched server-side where useful — not a DB column */
  sender_name?: string | null;
}

/**
 * Strip path separators + control chars so a filename is safe to embed
 * in a storage key. Keeps the extension recognizable for the allowlist.
 */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "_")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || "file"
  );
}

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

/**
 * Validate upload metadata before issuing a signed upload URL.
 * Returns an error string, or null when acceptable.
 */
export function validateUploadMeta(meta: { name?: string; size?: number }): string | null {
  if (!meta.name || typeof meta.name !== "string") return "File name is required";
  const ext = fileExtension(meta.name);
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return `File type ".${ext || "?"}" isn't supported. Accepted: PDF, CSV, Excel, images, bank exports (OFX/QFX/QBO), Word, ZIP.`;
  }
  if (typeof meta.size !== "number" || !Number.isFinite(meta.size) || meta.size <= 0) {
    return "File size is required";
  }
  if (meta.size > MAX_UPLOAD_BYTES) {
    return `File is too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`;
  }
  return null;
}

/**
 * Validate an attachments array submitted with a client message. Every
 * path must live under the client's own prefix — this is the ownership
 * boundary that stops a client referencing another client's files.
 */
export function validateAttachments(
  attachments: unknown,
  clientLinkId: string
): { ok: true; attachments: CommAttachment[] } | { ok: false; error: string } {
  if (!Array.isArray(attachments)) return { ok: false, error: "attachments must be an array" };
  if (attachments.length > 10) return { ok: false, error: "Max 10 attachments per message" };
  const clean: CommAttachment[] = [];
  for (const a of attachments) {
    if (!a || typeof a.path !== "string" || typeof a.name !== "string") {
      return { ok: false, error: "Malformed attachment entry" };
    }
    if (!a.path.startsWith(`${clientLinkId}/`) || a.path.includes("..")) {
      return { ok: false, error: "Attachment path is not yours" };
    }
    clean.push({
      path: a.path,
      name: sanitizeFilename(a.name),
      size: typeof a.size === "number" ? a.size : 0,
      content_type: typeof a.content_type === "string" ? a.content_type.slice(0, 100) : "",
    });
  }
  return { ok: true, attachments: clean };
}

/**
 * Best-effort email via Resend. Mirrors the /api/portal/support pattern
 * (raw fetch, no SDK). Returns true when Resend accepted the send; false
 * on any failure — callers treat email as a notification nicety, never
 * a delivery guarantee (the DB row is the source of truth).
 */
export async function sendResendEmail(params: {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[client-comms] RESEND_API_KEY not set — skipped email "${params.subject}"`);
    return false;
  }
  const fromEmail =
    process.env.SUPPORT_FROM_EMAIL || "Ironbooks Support <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: params.to,
        reply_to: params.replyTo,
        subject: params.subject,
        text: params.text,
      }),
    });
    if (!res.ok) {
      console.error(`[client-comms] Resend ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[client-comms] Resend network error: ${err?.message}`);
    return false;
  }
}

/**
 * Look up the active portal users for a client and email them that a new
 * message/notification is waiting. Best-effort — failures only log.
 */
export async function emailPortalUsersAboutMessage(
  service: any,
  params: {
    clientLinkId: string;
    clientName: string;
    kind: "message" | "notification";
    subject: string | null;
    body: string;
    portalOrigin: string;
  }
): Promise<void> {
  try {
    const { data: mappings } = await service
      .from("client_users")
      .select("user_id")
      .eq("client_link_id", params.clientLinkId)
      .eq("active", true);
    const userIds = ((mappings as any[]) || []).map((m) => m.user_id).filter(Boolean);
    if (userIds.length === 0) return;

    const { data: portalUsers } = await service
      .from("users")
      .select("email")
      .in("id", userIds)
      .eq("is_active", true);
    const emails = ((portalUsers as any[]) || []).map((u) => u.email).filter(Boolean);
    if (emails.length === 0) return;

    const noun = params.kind === "notification" ? "notification" : "message";
    const snippet = params.body.length > 400 ? `${params.body.slice(0, 400)}…` : params.body;
    await sendResendEmail({
      to: emails,
      replyTo: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
      subject: `[Ironbooks] New ${noun}${params.subject ? `: ${params.subject}` : ""} — ${params.clientName}`,
      text: [
        `Your Ironbooks bookkeeper sent you a new ${noun}.`,
        ``,
        snippet,
        ``,
        `Read and reply in your portal: ${params.portalOrigin}/portal/messages`,
      ].join("\n"),
    });
  } catch (err: any) {
    console.error(`[client-comms] emailPortalUsersAboutMessage failed: ${err?.message}`);
  }
}
