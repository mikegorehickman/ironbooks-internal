import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { provisionPortalUser } from "@/lib/portal-invite";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // bulk send — allow time for dozens of emails

/**
 * POST /api/admin/resend-logins   (admin/lead only)
 *
 * Bulk-resends the portal sign-in email to clients who have NEVER logged in.
 *   body:
 *     confirm: true            — actually SEND (default is a safe dry-run preview)
 *     include_no_account: true — also FIRST-invite active clients who have no
 *                                portal account yet (default false = resend only)
 *     client_link_id           — single-target mode: only this client (implies
 *                                include_no_account so a never-invited client
 *                                gets their first invite)
 *
 * Targets are active clients only. Excludes internal @ironbooks.com addresses,
 * "test" accounts, missing emails, and hard-bounced emails. Uses the shared,
 * idempotent provisionPortalUser (resend for existing users, invite for new),
 * with a gentle delay between sends. Records one audit_log entry.
 */
const EXCLUDE_EMAIL = /@ironbooks\.com$/i;

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const b = await request.json().catch(() => ({}));
  const confirm = b.confirm === true;
  const single = typeof b.client_link_id === "string" ? b.client_link_id : null;
  const includeNoAccount = b.include_no_account === true || !!single;

  let clsQuery = service
    .from("client_links")
    .select("id, client_name, client_email, contact_first_name, contact_last_name, email_hard_bounced")
    .eq("is_active", true);
  if (single) clsQuery = clsQuery.eq("id", single);
  const { data: cls } = await clsQuery;
  let cuQuery = (service as any)
    .from("client_users")
    .select("client_link_id, user_id, first_login_at, last_login_at, active");
  if (single) cuQuery = cuQuery.eq("client_link_id", single);
  const { data: cu } = await cuQuery;

  const maps = ((cu as any[]) || []).filter((m) => m.active !== false);
  const loggedIn = new Set(maps.filter((m) => m.first_login_at || m.last_login_at).map((m) => m.client_link_id));
  const acctByClient = new Map<string, any>();
  for (const m of maps) if (!acctByClient.has(m.client_link_id)) acctByClient.set(m.client_link_id, m);
  const userIds = [...new Set(maps.map((m) => m.user_id))];
  const { data: us } = await service.from("users").select("id, email, full_name").in("id", userIds);
  const userById = new Map(((us as any[]) || []).map((u) => [u.id, u]));
  const clById = new Map(((cls as any[]) || []).map((c) => [c.id, c]));

  type Target = { clientLinkId: string; email: string; name: string; kind: "resend" | "invite"; company: string; client: any };
  const targets: Target[] = [];

  // A) has a portal account but never logged in → RESEND
  for (const [clId, m] of acctByClient) {
    if (loggedIn.has(clId)) continue;
    const c = clById.get(clId); if (!c) continue;
    const u = userById.get(m.user_id);
    const email = String(u?.email || c.client_email || "").trim();
    const name = u?.full_name || [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") || c.client_name;
    targets.push({ clientLinkId: clId, email, name, kind: "resend", company: c.client_name, client: c });
  }
  // C) active client with NO portal account yet → FIRST INVITE (opt-in)
  if (includeNoAccount) {
    for (const c of (cls as any[]) || []) {
      if (acctByClient.has(c.id)) continue;
      const email = String(c.client_email || "").trim();
      const name = [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") || c.client_name;
      targets.push({ clientLinkId: c.id, email, name, kind: "invite", company: c.client_name, client: c });
    }
  }

  const skipped: { company: string; reason: string }[] = [];
  const send = targets.filter((t) => {
    if (!t.email || !t.email.includes("@")) { skipped.push({ company: t.company, reason: "no email" }); return false; }
    if (EXCLUDE_EMAIL.test(t.email)) { skipped.push({ company: t.company, reason: "internal @ironbooks.com" }); return false; }
    if (/\btest\b/i.test(t.company || "")) { skipped.push({ company: t.company, reason: "test account" }); return false; }
    if (t.client.email_hard_bounced) { skipped.push({ company: t.company, reason: "hard-bounced email" }); return false; }
    return true;
  });

  if (!confirm) {
    return NextResponse.json({
      dry_run: true,
      note: "Preview only — POST again with { confirm: true } to send.",
      would_send: send.length,
      resends: send.filter((t) => t.kind === "resend").length,
      first_invites: send.filter((t) => t.kind === "invite").length,
      skipped: skipped.length,
      recipients: send.map((t) => ({ company: t.company, email: t.email, kind: t.kind })),
      skippedList: skipped,
    });
  }

  const results = { sent: 0, failed: 0, details: [] as any[] };
  for (const t of send) {
    try {
      const r = await provisionPortalUser(service, {
        email: t.email, fullName: t.name, clientLinkId: t.clientLinkId, sendInvite: true, invitedBy: user.id,
      });
      if (r.ok) results.sent++; else results.failed++;
      results.details.push({ company: t.company, email: t.email, ok: r.ok, resend: (r as any).resend, error: (r as any).error });
    } catch (e: any) {
      results.failed++;
      results.details.push({ company: t.company, email: t.email, ok: false, error: e?.message || "threw" });
    }
    await new Promise((res) => setTimeout(res, 250)); // gentle pacing for Resend/Supabase
  }

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "bulk_portal_login_resend",
    request_payload: { sent: results.sent, failed: results.failed, include_no_account: includeNoAccount, single_client: single } as any,
  });

  return NextResponse.json({ ok: true, ...results });
}
