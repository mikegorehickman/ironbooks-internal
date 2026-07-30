import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound, redirect } from "next/navigation";
import { BookkeeperMessagesClient } from "./messages-client";
import type { ClientCommunication } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * /clients/[id]/messages — bookkeeper side of the client thread.
 *
 * Read inbound client messages + statement uploads, reply, or push a
 * one-way notification ("Your P&L is ready") that lights up the red
 * badge in the client's portal nav. Opening this page marks inbound
 * rows read, which also clears them from the /today inbox widget.
 */
export default async function ClientMessagesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) {
    redirect("/dashboard");
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", id)
    .single();
  if (!client) notFound();

  // Initial thread server-side; the client component takes over from there
  let messages: ClientCommunication[] = [];
  try {
    const { data: rows } = await (service as any)
      .from("client_communications")
      .select("*")
      .eq("client_link_id", id)
      .order("created_at", { ascending: false })
      .limit(500);
    messages = (((rows as ClientCommunication[]) || [])).reverse();

    // Senders plus whoever dismissed each inbound row (the thread tags it).
    const nameIds = [
      ...new Set(
        messages.flatMap((m) => [m.sender_user_id, m.dismissed_by]).filter(Boolean)
      ),
    ] as string[];
    if (nameIds.length > 0) {
      const { data: senders } = await service
        .from("users")
        .select("id, full_name, email")
        .in("id", nameIds);
      const byId = new Map(
        ((senders as any[]) || []).map((u) => [u.id, u.full_name || u.email])
      );
      for (const m of messages) {
        if (m.sender_user_id) m.sender_name = byId.get(m.sender_user_id) || null;
        if (m.dismissed_by) m.dismissed_by_name = byId.get(m.dismissed_by) || null;
      }
    }
  } catch {
    messages = []; // table not migrated yet
  }

  // Who's on the portal for this client — shown in the header so the
  // bookkeeper knows who will receive the message/email.
  let portalUserLabels: string[] = [];
  try {
    const { data: mappings } = await (service as any)
      .from("client_users")
      .select("user_id")
      .eq("client_link_id", id)
      .eq("active", true);
    const ids = ((mappings as any[]) || []).map((m) => m.user_id).filter(Boolean);
    if (ids.length > 0) {
      const { data: portalUsers } = await service
        .from("users")
        .select("full_name, email")
        .in("id", ids);
      portalUserLabels = ((portalUsers as any[]) || []).map(
        (u) => u.full_name || u.email || "(unnamed)"
      );
    }
  } catch {
    portalUserLabels = [];
  }

  return (
    <AppShell>
      <TopBar
        title={`Messages · ${(client as any).client_name}`}
        subtitle={
          portalUserLabels.length > 0
            ? `Portal users: ${portalUserLabels.join(", ")}`
            : "No portal users provisioned yet — messages will be visible once the client is invited"
        }
      />
      {/* max-w-6xl, not 4xl — statement-upload threads carry long filenames
          and the composer needs room to breathe on a wide monitor. */}
      <div className="px-8 py-6 max-w-6xl">
        <BookkeeperMessagesClient
          clientLinkId={id}
          initialMessages={messages}
          canSend={role !== "viewer"}
        />
      </div>
    </AppShell>
  );
}
