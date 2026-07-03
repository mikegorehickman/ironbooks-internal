import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import type { CommAttachment } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * GET /api/portal/documents
 *
 * Everything the client has ever uploaded (and every file their bookkeeper
 * sent them), merged into one document list for the portal Messages page:
 *
 *   - client_statements: bank/CC/loan statements filed through the upload
 *     panel (AI-matched to an account, or awaiting a manual match)
 *   - client_communications attachments: files sent either direction in the
 *     message thread
 *
 * Download happens through /api/client-files/download, which already scopes
 * portal users to their own client_link_id prefix in the private bucket.
 */

export interface PortalDocument {
  key: string;
  kind: "statement" | "attachment";
  name: string;
  /** Storage path in CLIENT_UPLOADS_BUCKET; null if the file has no path (never expected). */
  path: string | null;
  date: string;
  /** Statement-only: which account it was filed under. */
  account: string | null;
  /** Statement-only: "Mar 2026" style period label. */
  period: string | null;
  /** Statement-only: needs a manual account match. */
  needs_match: boolean;
  /** Attachment-only: who sent it. */
  direction: "from_client" | "to_client" | null;
  size: number | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ error: "No portal context" }, { status: 403 });
  const clientLinkId = ctxResult.ctx.clientLinkId;
  const service = createServiceSupabase();

  const [{ data: stmts }, { data: comms }] = await Promise.all([
    (service as any)
      .from("client_statements")
      .select("id, display_name, original_name, status, matched_account_name, account_label, period_month, period_year, storage_path, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(300),
    (service as any)
      .from("client_communications")
      .select("id, direction, attachments, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const documents: PortalDocument[] = [];
  const seenPaths = new Set<string>();

  for (const s of ((stmts as any[]) || [])) {
    if (s.storage_path) seenPaths.add(s.storage_path);
    const period =
      s.period_month && s.period_year
        ? `${MONTHS[Math.min(Math.max(s.period_month, 1), 12) - 1]} ${s.period_year}`
        : null;
    documents.push({
      key: `stmt-${s.id}`,
      kind: "statement",
      name: s.display_name || s.original_name || "Statement",
      path: s.storage_path || null,
      date: s.created_at,
      account: s.account_label || s.matched_account_name || null,
      period,
      needs_match: s.status === "unmatched",
      direction: null,
      size: null,
    });
  }

  for (const c of ((comms as any[]) || [])) {
    const atts = (c.attachments as CommAttachment[]) || [];
    for (const a of atts) {
      if (!a?.path || seenPaths.has(a.path)) continue;
      seenPaths.add(a.path);
      documents.push({
        key: `att-${c.id}-${a.path}`,
        kind: "attachment",
        name: a.name || "File",
        path: a.path,
        date: c.created_at,
        account: null,
        period: null,
        needs_match: false,
        direction: c.direction,
        size: typeof a.size === "number" ? a.size : null,
      });
    }
  }

  documents.sort((a, b) => (a.date < b.date ? 1 : -1));

  return NextResponse.json({ documents });
}
