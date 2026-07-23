import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/** Email domain that gets auto-provisioned as bookkeeper on first sign-in.
 *  Lowercase, includes the leading @. Every email not matching this gets
 *  rejected if they don't already have a users row — prevents random
 *  magic-link signups from ending up half-authenticated. */
const INTERNAL_EMAIL_DOMAIN = "@ironbooks.com";

/**
 * Auth callback — exchanges the magic-link code for a session, then routes
 * the user to either the bookkeeper dashboard or the client portal based
 * on their role.
 *
 * Order of preference for the redirect destination:
 *   1. Explicit `next` query param — invite emails drop you on a specific page
 *   2. role='client'    → /portal
 *   3. everything else  → /today (the internal daily command center)
 *
 * Auto-provisioning: if no users row exists for this auth user and the
 * email ends in @ironbooks.com, we create a bookkeeper row on the fly.
 * Anyone else with no row gets signed out + bounced to login with an
 * error — prevents a "signed in but broken" half-state for stray emails
 * that weren't pre-invited as clients.
 *
 * Service client reads the role row so we don't depend on RLS policies
 * being wired up against the session that just got issued.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type");
  const explicitNext = searchParams.get("next");

  const supabase = await createServerSupabase();

  // Two sign-in link flavors converge here:
  //   • token_hash + type → verifyOtp. This is the flow for emailed links we
  //     mint server-side (/auth/activate, invites, resends). It is NOT bound to
  //     the browser that requested it — so it works when the client opens the
  //     link on a different device / in their email app's in-app browser, which
  //     is exactly where the old PKCE-only path failed for some users.
  //   • code → exchangeCodeForSession (PKCE). This is the login-page flow
  //     (signInWithOtp sets a verifier cookie in the requesting browser).
  if (tokenHash && otpType) {
    const { error } = await supabase.auth.verifyOtp({
      type: otpType as any,
      token_hash: tokenHash,
    });
    if (error) {
      return NextResponse.redirect(`${origin}/auth/login?error=oauth_failed`);
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/auth/login?error=oauth_failed`);
    }
  } else {
    return NextResponse.redirect(`${origin}/auth/login?error=missing_code`);
  }

  if (explicitNext) {
    return NextResponse.redirect(`${origin}${explicitNext}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/dashboard`);
  }

  const service = createServiceSupabase();
  let { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  // ─── Auto-provision / gatekeep ──────────────────────────────────────
  // No users row exists yet for this auth user. Either:
  //   (a) they're an Ironbooks team member self-registering → create
  //       a bookkeeper row and keep going.
  //   (b) they're an external email that somehow got a magic link but
  //       was never invited → sign them out and bounce to login with
  //       an error so they don't end up in an authenticated-but-roleless
  //       half-state where every page 403s.
  if (!profile) {
    const email = (user.email || "").toLowerCase().trim();
    const isInternal = email.endsWith(INTERNAL_EMAIL_DOMAIN);
    if (isInternal) {
      // Derive a sensible default full_name from the email local-part
      // ("mike.gore" → "Mike Gore"). They can update later from settings.
      const localPart = email.slice(0, -INTERNAL_EMAIL_DOMAIN.length);
      const derivedName = localPart
        .replace(/[._-]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim() || email;

      const { error: insertErr } = await service.from("users").insert({
        id: user.id,
        email,
        full_name: derivedName,
        role: "bookkeeper",
        is_active: true,
      } as any);
      if (insertErr) {
        // Insert failed — most likely a race (another tab raced to insert).
        // Re-read to confirm. If still missing, surface a real error rather
        // than dropping the user into a broken dashboard.
        const reread = await service
          .from("users")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();
        if (!reread.data) {
          console.error(
            `[auth/callback] failed to auto-provision ${email}: ${insertErr.message}`
          );
          await supabase.auth.signOut();
          return NextResponse.redirect(
            `${origin}/auth/login?error=provision_failed`
          );
        }
        profile = reread.data as any;
      } else {
        await service.from("audit_log").insert({
          event_type: "bookkeeper_self_registered",
          user_id: user.id,
          request_payload: { email, derived_name: derivedName } as any,
        });
        profile = { role: "bookkeeper" } as any;
      }
    } else {
      // External email with no invite — kill the session and tell them.
      // This catches typos (someone enters a personal email instead of
      // their work email) and stops accidental "ghost" accounts from
      // accumulating in auth.users without matching profiles.
      console.warn(
        `[auth/callback] rejecting unprovisioned external email: ${email}`
      );
      await supabase.auth.signOut();
      return NextResponse.redirect(
        `${origin}/auth/login?error=not_authorized&email=${encodeURIComponent(email)}`
      );
    }
  }

  if ((profile as any)?.role === "client") {
    // Stamp last_login + first_login (if not already set) + audit log.
    // Best-effort — never blocks the redirect on a DB hiccup.
    try {
      const now = new Date().toISOString();

      // Read prior state so we can tell first-login-vs-returning in the audit entry
      const { data: priorMapping } = await service
        .from("client_users" as any)
        .select("first_login_at, client_link_id")
        .eq("user_id", user.id)
        .maybeSingle();

      await service
        .from("client_users" as any)
        .update({ last_login_at: now } as any)
        .eq("user_id", user.id);
      await service
        .from("client_users" as any)
        .update({ first_login_at: now } as any)
        .eq("user_id", user.id)
        .is("first_login_at", null);

      const isFirstLogin = !(priorMapping as any)?.first_login_at;
      await service.from("audit_log").insert({
        event_type: isFirstLogin ? "portal_first_login" : "portal_login",
        user_id: user.id,
        request_payload: {
          client_link_id: (priorMapping as any)?.client_link_id ?? null,
        } as any,
      });
    } catch {
      // ignore — telemetry shouldn't break login
    }
    return NextResponse.redirect(`${origin}/portal`);
  }

  return NextResponse.redirect(`${origin}/today`);
}
