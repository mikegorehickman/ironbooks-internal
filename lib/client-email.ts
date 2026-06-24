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
