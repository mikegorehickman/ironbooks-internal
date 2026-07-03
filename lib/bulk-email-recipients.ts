import type { SupabaseClient } from "@supabase/supabase-js";

/** A client as a potential bulk-email recipient, with segments + consent. */
export interface RecipientRow {
  client_link_id: string;
  client_name: string;
  first_name: string | null;
  email: string | null;          // resolved: portal email → contact email
  login_email: string | null;    // portal login (auth) email only; null if no portal user
  has_portal: boolean;
  jurisdiction: string | null;
  in_production: boolean;
  bookkeeper_id: string | null;
  bookkeeper_name: string | null;
  subscribed: boolean;           // marketing consent
  bounced: boolean;              // hard-bounced — never email
}

/**
 * Load every active client as a candidate recipient with resolved email,
 * segment fields (jurisdiction / production / bookkeeper / portal), and consent
 * state. The picker filters + selects from this; the send route re-derives the
 * final list from the chosen ids so the client can't spoof consent.
 */
export async function loadBulkRecipients(service: SupabaseClient): Promise<RecipientRow[]> {
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, contact_first_name, client_email, jurisdiction, assigned_bookkeeper_id, daily_recon_enabled, marketing_subscribed, email_hard_bounced")
    .eq("is_active", true)
    .order("client_name");
  const rows = (clients as any[]) || [];
  const ids = rows.map((c) => c.id);

  // Portal email per client (first active portal user).
  const portalEmailByClient = new Map<string, string>();
  const bkIds = new Set<string>();
  for (const c of rows) if (c.assigned_bookkeeper_id) bkIds.add(c.assigned_bookkeeper_id);
  try {
    const { data: cu } = await (service as any)
      .from("client_users").select("client_link_id, user_id").eq("active", true).in("client_link_id", ids);
    const userIds = [...new Set(((cu as any[]) || []).map((m) => m.user_id).filter(Boolean))];
    const { data: us } = userIds.length
      ? await service.from("users").select("id, email").in("id", userIds)
      : { data: [] };
    const emailById = new Map(((us as any[]) || []).map((u) => [u.id, u.email]));
    for (const m of ((cu as any[]) || [])) {
      if (portalEmailByClient.has(m.client_link_id)) continue;
      const e = emailById.get(m.user_id);
      if (e) portalEmailByClient.set(m.client_link_id, e);
    }
  } catch { /* portal mapping optional */ }

  // Bookkeeper names.
  const bkNameById = new Map<string, string>();
  if (bkIds.size) {
    const { data: bks } = await service.from("users").select("id, full_name").in("id", [...bkIds]);
    for (const b of ((bks as any[]) || [])) bkNameById.set(b.id, b.full_name);
  }

  return rows.map((c) => {
    const portal = portalEmailByClient.get(c.id) || null;
    const loginEmail = (portal || "").trim().toLowerCase() || null;
    const email = (portal || c.client_email || "").trim().toLowerCase() || null;
    return {
      client_link_id: c.id,
      client_name: c.client_name,
      first_name: c.contact_first_name ?? null,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      login_email: loginEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail) ? loginEmail : null,
      has_portal: !!portal,
      jurisdiction: c.jurisdiction ?? null,
      in_production: !!c.daily_recon_enabled,
      bookkeeper_id: c.assigned_bookkeeper_id ?? null,
      bookkeeper_name: c.assigned_bookkeeper_id ? (bkNameById.get(c.assigned_bookkeeper_id) || null) : null,
      subscribed: c.marketing_subscribed !== false,
      bounced: c.email_hard_bounced === true,
    };
  });
}
