import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { syncClientLoginEmail, findDesyncedClientLogins } from "@/lib/client-email";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Admin maintenance: repoint client portal LOGIN emails to match their
 * contact email, for clients left desynced by email edits made before the
 * profile path repointed logins.
 *
 *   GET  → preview the desynced clients (no changes)
 *   POST → repoint every desynced single-login client via syncClientLoginEmail
 *
 * Admin/lead only. Each repoint goes through the Supabase Admin API (not raw
 * SQL on auth.users) and is audit-logged.
 */

async function gate() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Admin or lead only" }, { status: 403 }) };
  }
  return { user, service };
}

export async function GET() {
  const g = await gate();
  if (g.error) return g.error;
  const desynced = await findDesyncedClientLogins(g.service!);
  return NextResponse.json({ desynced });
}

export async function POST() {
  const g = await gate();
  if (g.error) return g.error;
  const { user, service } = g as { user: any; service: ReturnType<typeof createServiceSupabase> };

  const desynced = await findDesyncedClientLogins(service);
  const results: Array<{
    client_name: string;
    to: string;
    from: string;
    ok: boolean;
    error: string | null;
  }> = [];

  for (const d of desynced) {
    const r = await syncClientLoginEmail(service, d.client_link_id, d.contact_email);
    results.push({
      client_name: d.client_name,
      to: d.contact_email,
      from: d.login_email,
      ok: r.portalUpdated === 1,
      error: r.error || r.note,
    });
  }

  const updated = results.filter((r) => r.ok).length;
  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "client_logins_resynced",
    request_payload: { attempted: results.length, updated, results } as any,
  });

  return NextResponse.json({ attempted: results.length, updated, results });
}
