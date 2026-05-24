import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { InviteClientUI } from "./invite-client-ui";

export const dynamic = "force-dynamic";

/**
 * /admin/invite-client
 *
 * Admin-only page for sending portal invites and managing existing client
 * portal users.
 *
 * Pulls in one server-rendered shot:
 *   - All active client_links (for the picker)
 *   - All existing client_users rows joined to their user + client_link
 *     (for the management list at the bottom)
 *
 * Mutations (invite, resend, revoke) go through /api/admin/invite-client.
 */
export default async function InviteClientPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    redirect("/dashboard");
  }

  // Pull active clients for the picker
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, client_email")
    .eq("is_active", true)
    .order("client_name");

  // Pull existing client_users with their user + client_name. We do two
  // queries + manual join — simpler than fighting the Supabase typed
  // select syntax for nested relations on dynamic-table refs.
  const { data: mappings } = await service
    .from("client_users" as any)
    .select("id, user_id, client_link_id, invited_at, first_login_at, last_login_at, active, invited_by")
    .order("invited_at", { ascending: false });

  const mappingRows = (mappings as any[]) || [];
  const userIds = Array.from(new Set(mappingRows.map((m) => m.user_id)));
  const clientIds = Array.from(new Set(mappingRows.map((m) => m.client_link_id)));
  const inviterIds = Array.from(new Set(mappingRows.map((m) => m.invited_by).filter(Boolean)));
  const allUserIds = Array.from(new Set([...userIds, ...inviterIds]));

  const [{ data: users }, { data: clientNames }] = await Promise.all([
    allUserIds.length > 0
      ? service.from("users").select("id, email, full_name, role, is_active").in("id", allUserIds)
      : Promise.resolve({ data: [] }),
    clientIds.length > 0
      ? service.from("client_links").select("id, client_name").in("id", clientIds)
      : Promise.resolve({ data: [] }),
  ]);

  const userById = new Map((users as any[] || []).map((u) => [u.id, u]));
  const clientById = new Map((clientNames as any[] || []).map((c) => [c.id, c]));

  const enrichedMappings = mappingRows.map((m) => ({
    id: m.id,
    user_id: m.user_id,
    client_link_id: m.client_link_id,
    invited_at: m.invited_at,
    first_login_at: m.first_login_at,
    last_login_at: m.last_login_at,
    active: m.active,
    user_email: userById.get(m.user_id)?.email || "(unknown)",
    user_full_name: userById.get(m.user_id)?.full_name || "",
    user_active: userById.get(m.user_id)?.is_active ?? true,
    client_name: clientById.get(m.client_link_id)?.client_name || "(unknown client)",
    invited_by_name: m.invited_by ? userById.get(m.invited_by)?.full_name || "" : "",
  }));

  return (
    <AppShell>
      <TopBar
        title="Client portal invites"
        subtitle="Invite clients to the financial-literacy portal · resend magic links · revoke access"
      />
      <div className="px-8 py-6 max-w-5xl">
        <InviteClientUI
          clients={(clients as any[]) || []}
          existingMappings={enrichedMappings}
        />
      </div>
    </AppShell>
  );
}
