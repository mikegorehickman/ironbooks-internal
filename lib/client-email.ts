import type { createServiceSupabase } from "@/lib/supabase";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LoginEmailSync = {
  /** 1 when a portal login's auth email was repointed; 0 otherwise. */
  portalUpdated: number;
  /** Benign explanation when no single login was repointed (none / multiple). */
  note: string | null;
  /** Hard failure (e.g. the new address already belongs to another login). */
  error: string | null;
};

/**
 * Repoint a client's portal LOGIN email to match a new contact email.
 *
 * Updates the Supabase auth user + public.users.email when the client has
 * exactly one active portal login. No-op (with an explanatory note) for zero
 * or multiple logins, or an invalid address. The caller is responsible for the
 * client_links.client_email write — this only syncs the login side, so both
 * the admin panel and the client-profile edit keep login + contact in sync.
 */
export async function syncClientLoginEmail(
  service: ReturnType<typeof createServiceSupabase>,
  clientLinkId: string,
  email: string
): Promise<LoginEmailSync> {
  const clean = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) {
    return {
      portalUpdated: 0,
      error: null,
      note: "Contact email saved, but it isn't a valid address — portal login left unchanged.",
    };
  }

  // Active portal logins for this client.
  const { data: maps } = await (service as any)
    .from("client_users")
    .select("user_id")
    .eq("client_link_id", clientLinkId)
    .eq("active", true);
  const userIds = ((maps as any[]) || []).map((m) => m.user_id).filter(Boolean);

  if (userIds.length === 0) {
    // No portal login yet (e.g. not invited) — nothing to repoint.
    return { portalUpdated: 0, error: null, note: null };
  }
  if (userIds.length > 1) {
    return {
      portalUpdated: 0,
      error: null,
      note: `Contact email updated, but this client has ${userIds.length} portal logins — repoint each individually so the wrong one isn't changed.`,
    };
  }

  const uid = userIds[0];
  const { data: u } = await service
    .from("users")
    .select("id, role")
    .eq("id", uid)
    .maybeSingle();
  if ((u as any)?.role !== "client") {
    return { portalUpdated: 0, error: null, note: null };
  }

  const { error: authErr } = await (service as any).auth.admin.updateUserById(uid, {
    email: clean,
    email_confirm: true,
  });
  if (authErr) {
    return {
      portalUpdated: 0,
      error: `Couldn't change the portal login — ${authErr.message}. The new address may already belong to another login.`,
      note: null,
    };
  }
  await service.from("users").update({ email: clean } as any).eq("id", uid);
  return { portalUpdated: 1, error: null, note: null };
}

export type DesyncedLogin = {
  client_link_id: string;
  client_name: string;
  contact_email: string;
  login_email: string;
  user_id: string;
};

/**
 * Find clients whose single active portal LOGIN email no longer matches their
 * client_links.client_email — the leftover desync from email edits made before
 * the profile path repointed logins. Scoped to single-login client accounts
 * (the only ones we can safely auto-repoint; multi-login clients are skipped).
 */
export async function findDesyncedClientLogins(
  service: ReturnType<typeof createServiceSupabase>
): Promise<DesyncedLogin[]> {
  const { data: maps } = await (service as any)
    .from("client_users")
    .select("user_id, client_link_id")
    .eq("active", true);
  const rows = ((maps as any[]) || []).filter((r) => r.user_id && r.client_link_id);
  if (!rows.length) return [];

  const byClient = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byClient.get(r.client_link_id) || [];
    arr.push(r.user_id);
    byClient.set(r.client_link_id, arr);
  }

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const clientIds = [...byClient.keys()];
  const { data: users } = await service.from("users").select("id, email, role").in("id", userIds);
  const userById = new Map(((users as any[]) || []).map((u) => [u.id, u]));
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, client_email")
    .in("id", clientIds);
  const clientById = new Map(((clients as any[]) || []).map((c) => [c.id, c]));

  const out: DesyncedLogin[] = [];
  for (const [clientLinkId, ids] of byClient) {
    const clientLogins = ids.map((id) => userById.get(id)).filter((u) => u && (u as any).role === "client");
    if (clientLogins.length !== 1) continue; // only safe single-login accounts
    const login: any = clientLogins[0];
    const cl: any = clientById.get(clientLinkId);
    if (!cl?.client_email) continue;
    if (String(cl.client_email).toLowerCase() !== String(login.email || "").toLowerCase()) {
      out.push({
        client_link_id: clientLinkId,
        client_name: cl.client_name,
        contact_email: cl.client_email,
        login_email: login.email,
        user_id: login.id,
      });
    }
  }
  return out;
}
