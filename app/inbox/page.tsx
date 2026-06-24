import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { InboxClient, type InboxThread } from "./inbox-client";

export const dynamic = "force-dynamic";

/**
 * /inbox — unified client message inbox. Every client thread in one place,
 * oldest-unanswered first, with the thread + reply composer inline (no need to
 * open each client page). Bookkeepers see their assigned clients; seniors see all.
 */
export async function InboxContent() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) redirect("/dashboard");
  const isSenior = ["admin", "lead"].includes(role);
  const canSend = role !== "viewer";

  // Scope: bookkeepers → their assigned clients; seniors → all active.
  let clientsQuery = service
    .from("client_links")
    .select("id, client_name, assigned_bookkeeper_id")
    .eq("is_active", true);
  if (!isSenior) clientsQuery = clientsQuery.eq("assigned_bookkeeper_id", user.id);
  const { data: clients } = await clientsQuery;
  const nameById = new Map<string, string>();
  for (const c of ((clients as any[]) || [])) nameById.set(c.id, c.client_name);
  const allowed = new Set(nameById.keys());

  // Pull recent comms, group into per-client threads.
  let threads: InboxThread[] = [];
  try {
    const { data: comms } = await (service as any)
      .from("client_communications")
      .select("client_link_id, direction, body, subject, created_at, read_at")
      .order("created_at", { ascending: false })
      .limit(2000);
    const byClient = new Map<string, InboxThread>();
    for (const m of ((comms as any[]) || [])) {
      const cid = m.client_link_id;
      if (!cid || !allowed.has(cid)) continue;
      let t = byClient.get(cid);
      if (!t) {
        t = {
          clientLinkId: cid,
          clientName: nameById.get(cid) || "Client",
          preview: (m.subject || m.body || "").slice(0, 120),
          lastAt: m.created_at,
          unread: 0,
          oldestUnreadAt: null,
        };
        byClient.set(cid, t);
      }
      if (m.direction === "from_client" && !m.read_at) {
        t.unread++;
        // comms are newest-first, so the last unread we see is the oldest.
        t.oldestUnreadAt = m.created_at;
      }
    }
    threads = [...byClient.values()].sort((a, b) => {
      // Unread threads first, oldest-waiting at the top; then by latest activity.
      if (a.unread && b.unread) return (a.oldestUnreadAt || "").localeCompare(b.oldestUnreadAt || "");
      if (a.unread !== b.unread) return a.unread ? -1 : 1;
      return (b.lastAt || "").localeCompare(a.lastAt || "");
    });
  } catch {
    threads = [];
  }

  return (
    <div className="px-8 py-6">
      <InboxClient threads={threads} canSend={canSend} />
    </div>
  );
}

/** Standalone /inbox — wraps the shared InboxContent in the app shell (V1). */
export default async function InboxPage() {
  return (
    <AppShell>
      <TopBar title="Inbox" subtitle="All client messages · oldest-waiting first" />
      <InboxContent />
    </AppShell>
  );
}
