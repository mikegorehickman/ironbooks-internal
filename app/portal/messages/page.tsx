import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { MessagesClient } from "./messages-client";
import { StatementUploadPanel } from "./statement-upload-panel";
import { DocumentsPanel } from "./documents-panel";
import type { ClientCommunication } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * /portal/messages — the client side of the bookkeeper↔client thread.
 *
 * Clients can:
 *   - read messages + notifications from their bookkeeper
 *   - reply with text
 *   - upload statements (PDF/CSV/Excel/bank exports) as attachments
 *
 * Initial thread is fetched server-side for a fast first paint; the
 * client component handles sending, uploading, and mark-as-read.
 */
export default async function PortalMessagesPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();
  let messages: ClientCommunication[] = [];
  try {
    const { data: rows } = await (service as any)
      .from("client_communications")
      .select("*")
      .eq("client_link_id", ctx.clientLinkId)
      .order("created_at", { ascending: false })
      .limit(200);
    messages = (((rows as ClientCommunication[]) || [])).reverse();

    const senderIds = [
      ...new Set(
        messages
          .filter((m) => m.direction === "to_client" && m.sender_user_id)
          .map((m) => m.sender_user_id)
      ),
    ] as string[];
    if (senderIds.length > 0) {
      const { data: senders } = await service
        .from("users")
        .select("id, full_name")
        .in("id", senderIds);
      const nameById = new Map(((senders as any[]) || []).map((u) => [u.id, u.full_name]));
      for (const m of messages) {
        if (m.direction === "to_client" && m.sender_user_id) {
          m.sender_name = nameById.get(m.sender_user_id) || null;
        }
      }
    }
  } catch {
    // Table not migrated yet — render the empty thread rather than crash.
    messages = [];
  }

  return (
    <div className="space-y-6">
      {/* Gradient hero — matches the portal visual system */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-amber-300/15 blur-2xl" />
        <div className="relative">
          <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">
            Your bookkeeping team
          </div>
          <h1 className="text-3xl font-bold mt-1">Messages</h1>
          <div className="text-sm text-white/70 mt-1">
            Ask your bookkeeper questions, send documents like bank statements, and get
            updates on your cleanup progress — all in one place.
          </div>
        </div>
      </div>

      <StatementUploadPanel />

      <MessagesClient initialMessages={messages} />

      {/* Permanent archive: every past statement + file upload, below the thread. */}
      <DocumentsPanel />
    </div>
  );
}
