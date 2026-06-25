import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /auth/activate?token=…
 *
 * Consumes a 7-day portal activation token (migration 92). Within the window it
 * confirms the user's email and mints a FRESH short-lived Supabase magic link,
 * then redirects the browser to it (which signs them in via /auth/callback).
 * This is what our invite/resend emails link to, so the client's link works for
 * a full week even though Supabase's own links expire in ≤24h.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token") || "";
  if (!token) return NextResponse.redirect(`${origin}/auth/login?error=missing_code`);

  const service = createServiceSupabase();
  const { data: row } = await (service as any)
    .from("portal_invite_tokens")
    .select("id, email, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!row) return NextResponse.redirect(`${origin}/auth/login?error=expired_invite`);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return NextResponse.redirect(
      `${origin}/auth/login?error=expired_invite&email=${encodeURIComponent(row.email)}`
    );
  }

  const email: string = row.email;

  // Confirm the email so the magic-link sign-in works on an invite-only
  // instance (an unconfirmed user can't otherwise complete sign-in).
  try {
    const { data: list } = await (service as any).auth.admin.listUsers({ page: 1, perPage: 200 });
    const authUser = (list?.users || []).find((u: any) => (u.email || "").toLowerCase() === email.toLowerCase());
    if (authUser && !authUser.email_confirmed_at) {
      await (service as any).auth.admin.updateUserById(authUser.id, { email_confirm: true });
    }
  } catch {
    /* best-effort — generateLink below still works for confirmed users */
  }

  // Mint a fresh short-lived sign-in link and bounce the browser to it.
  const redirectTo = `${origin}/auth/callback`;
  let link: string | null = null;
  try {
    const ml = await (service as any).auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    link = ml?.data?.properties?.action_link || null;
    if (!link) {
      const inv = await (service as any).auth.admin.generateLink({
        type: "invite",
        email,
        options: { redirectTo },
      });
      link = inv?.data?.properties?.action_link || null;
    }
  } catch {
    link = null;
  }
  if (!link) return NextResponse.redirect(`${origin}/auth/login?error=expired_invite&email=${encodeURIComponent(email)}`);

  await (service as any)
    .from("portal_invite_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id);

  return NextResponse.redirect(link);
}
