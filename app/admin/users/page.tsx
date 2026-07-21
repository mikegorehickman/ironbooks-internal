import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { UsersTabs } from "./users-tabs";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  // ?tab=clients deep-links straight to the Clients tab (the admin hub's
  // "Clients" button) — clients were otherwise 3 clicks deep (Mike, 2026-07-21).
  const sp = await searchParams;
  const initialTab = sp.tab === "clients" ? ("clients" as const) : ("employees" as const);
  const supabase = await createServerSupabase();
  const service = createServiceSupabase();

  // ── EMPLOYEES — internal staff only. Portal clients also live in `users`
  //    (role='client'); exclude them so they don't bleed into Team Management.
  //    Read the roster from the `users` table (authoritative — it INCLUDES
  //    deactivated staff so they can be reactivated; the user_activity_stats
  //    view filters to active users) and enrich with productivity stats by id.
  const { data: staffRows } = await supabase
    .from("users")
    .select("id, email, full_name, role, is_active, created_at, last_login_at")
    .neq("role", "client")
    .order("created_at", { ascending: true });
  const { data: statRows } = await supabase
    .from("user_activity_stats")
    .select("*")
    .neq("role", "client");
  const statsById = new Map(((statRows || []) as any[]).map((s) => [s.id, s]));
  const employees = ((staffRows || []) as any[]).map((u) => ({
    ...(statsById.get(u.id) || {}),
    ...u, // the users row is authoritative for identity + is_active
  }));

  // ── CLIENTS — the companies we keep books for (client_links), enriched with
  //    whether they have an active client-portal login (for the badge, the
  //    "portal users only" filter, and the impersonate shortcut).
  // select("*") so the page keeps working before migration 72 (client_phone)
  // is applied — we read client_phone defensively below.
  const { data: clientRows } = await service
    .from("client_links")
    .select("*")
    .order("client_name", { ascending: true });

  // Portal logins per client_link → active count, provisioned-ever, last login.
  // A client_link can have several portal users; "last login" is the most
  // recent sign-in across all of them (client_users.last_login_at is stamped
  // on every magic-link callback — see app/auth/callback/route.ts).
  // We fetch ALL mappings (not just active) so the UI can tell apart a client
  // that was never invited from one whose portal access was deactivated.
  const { data: portalRows } = await service
    .from("client_users" as any)
    .select("client_link_id, active, last_login_at");
  const portalCount = new Map<string, number>();   // active mappings
  const provisioned = new Set<string>();           // any mapping ever
  const lastLogin = new Map<string, string>();
  for (const r of (portalRows || []) as any[]) {
    if (!r.client_link_id) continue;
    provisioned.add(r.client_link_id);
    if (r.active) {
      portalCount.set(r.client_link_id, (portalCount.get(r.client_link_id) || 0) + 1);
    }
    if (r.last_login_at) {
      const prev = lastLogin.get(r.client_link_id);
      if (!prev || r.last_login_at > prev) lastLogin.set(r.client_link_id, r.last_login_at);
    }
  }

  // Opportunistic phone fallback from the GHL onboarding lead, when that table
  // exists (migration 70). Wrapped so it no-ops cleanly before that ships.
  const onboardingPhone = new Map<string, string>();
  try {
    const { data: leads } = await service
      .from("onboarding_leads" as any)
      .select("client_link_id, phone")
      .not("client_link_id", "is", null)
      .not("phone", "is", null);
    for (const l of (leads || []) as any[]) {
      if (l.client_link_id && l.phone && !onboardingPhone.has(l.client_link_id)) {
        onboardingPhone.set(l.client_link_id, l.phone);
      }
    }
  } catch {
    // onboarding_leads not present yet — phone simply falls back to "—".
  }

  // Assigned-bookkeeper id → name, built from the staff list (no extra query).
  const bkName = new Map<string, string>();
  for (const e of (employees || []) as any[]) {
    if (e.id) bkName.set(e.id, e.full_name || e.email);
  }

  const clients = ((clientRows || []) as any[]).map((c) => ({
    id: c.id,
    client_name: c.client_name,
    client_email: c.client_email ?? null,
    client_phone: c.client_phone || onboardingPhone.get(c.id) || null,
    status: c.status ?? null,
    is_active: c.is_active !== false,
    assigned_bookkeeper_name: c.assigned_bookkeeper_id ? bkName.get(c.assigned_bookkeeper_id) || null : null,
    has_portal: (portalCount.get(c.id) || 0) > 0,
    portal_user_count: portalCount.get(c.id) || 0,
    portal_provisioned: provisioned.has(c.id),
    last_login_at: lastLogin.get(c.id) || null,
    created_at: c.created_at,
    // Reminder tracking (migration 106) — undefined pre-migration, read via select("*").
    reminder_last_sent_at: c.login_reminder_last_sent_at ?? null,
    reminder_count: c.login_reminder_count ?? 0,
    email_bounced: c.email_hard_bounced === true,
    last_email_opened_at: c.last_email_opened_at ?? null,
  }));

  return (
    <AppShell>
      <TopBar
        title="User Management"
        subtitle={`${employees?.length || 0} employees · ${clients.length} clients`}
      />
      <div className="px-8 py-6">
        <UsersTabs employees={employees || []} clients={clients} initialTab={initialTab} />
      </div>
    </AppShell>
  );
}
