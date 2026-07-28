import { resolvePortalContextAllowNoQbo } from "@/lib/portal-context";
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
  const ctxResult = await resolvePortalContextAllowNoQbo();
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
      <header className="min-w-0">
        <div className="font-brand text-[11px] uppercase tracking-[0.14em] text-teal-dark">Your bookkeeping team</div>
        <h1 className="font-brand text-3xl font-semibold text-navy leading-none mt-1.5">Messages</h1>
        <div className="text-sm text-ink-slate mt-2 max-w-2xl">
          Ask your bookkeeper questions, send documents like bank statements, and get
          updates on your cleanup progress — all in one place.
        </div>
      </header>

      <StatementUploadPanel />

      <MessagesClient initialMessages={messages} />

      {/* Permanent archive: every past statement + file upload, below the thread. */}
      <DocumentsPanel />
    </div>
  );
}
