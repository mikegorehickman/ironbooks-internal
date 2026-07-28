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
export default async function InboxPage() {
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
  // is_active IS NULL on legacy rows means active (same convention as
  // /clients) — `.eq(is_active, true)` silently dropped those clients and
  // their whole message history from this page while the sidebar badge
  // kept counting them.
  let clientsQuery = service
    .from("client_links")
    .select("id, client_name, assigned_bookkeeper_id, is_active");
  if (!isSenior) clientsQuery = clientsQuery.eq("assigned_bookkeeper_id", user.id);
  const { data: clients } = await clientsQuery;
  const nameById = new Map<string, string>();
  // Clients nobody owns land in no bookkeeper's personal queue — only a
  // manager's fleet-wide view will ever show them, so tag them there.
  const unassignedIds = new Set<string>();
  for (const c of ((clients as any[]) || [])) {
    if (c.is_active === false) continue;
    nameById.set(c.id, c.client_name);
    if (!c.assigned_bookkeeper_id) unassignedIds.add(c.id);
  }
  const allowed = new Set(nameById.keys());

  // Pull recent comms, group into per-client threads. The client filter goes
  // INTO the query — fetching a fleet-wide newest-2000 and filtering after
  // meant a bookkeeper's oldest unanswered thread fell off the end once the
  // firm accumulated 2000 newer rows, taking the thread with it.
  let threads: InboxThread[] = [];
  try {
    const { data: comms } = allowed.size === 0
      ? { data: [] }
      : await (service as any)
          .from("client_communications")
          .select("client_link_id, direction, body, subject, created_at, read_at")
          .in("client_link_id", [...allowed])
          .order("created_at", { ascending: false })
          .limit(2000);
    // Open (undismissed) rows are fetched on their OWN query with no recency
    // window: a message still owed a reply must surface no matter how far it
    // has slid down the firm-wide timeline. The 2000-row pull above is only
    // for previews. Note this is dismissed_at, not read_at — reading a thread
    // doesn't answer the client (migration 144).
    const { data: unreadRows } = allowed.size === 0
      ? { data: [] }
      : await (service as any)
          .from("client_communications")
          .select("client_link_id, body, subject, created_at")
          .in("client_link_id", [...allowed])
          .eq("direction", "from_client")
          .is("dismissed_at", null)
          .order("created_at", { ascending: false });

    const byClient = new Map<string, InboxThread>();
    const mkThread = (cid: string, m: any): InboxThread => ({
      clientLinkId: cid,
      clientName: nameById.get(cid) || "Client",
      preview: (m.subject || m.body || "").slice(0, 120),
      lastAt: m.created_at,
      unread: 0,
      oldestUnreadAt: null,
      unassigned: unassignedIds.has(cid),
    });

    for (const m of ((comms as any[]) || [])) {
      const cid = m.client_link_id;
      if (!cid || !allowed.has(cid)) continue;
      if (!byClient.has(cid)) byClient.set(cid, mkThread(cid, m));
    }
    for (const m of ((unreadRows as any[]) || [])) {
      const cid = m.client_link_id;
      if (!cid || !allowed.has(cid)) continue;
      let t = byClient.get(cid);
      // Thread older than the preview window — still belongs in the inbox.
      if (!t) { t = mkThread(cid, m); byClient.set(cid, t); }
      t.unread++;
      // newest-first, so the last unread we see is the oldest.
      t.oldestUnreadAt = m.created_at;
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
    <AppShell>
      <TopBar title="Inbox" subtitle="All client messages · oldest-waiting first" />
      <div className="px-8 py-6">
        <InboxClient threads={threads} canSend={canSend} />
      </div>
    </AppShell>
  );
}
