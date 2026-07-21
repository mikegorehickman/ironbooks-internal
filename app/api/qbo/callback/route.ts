import { exchangeCodeForTokens, fetchCompanyInfo, markQboConnectionHealthy } from "@/lib/qbo";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { sendWalkthroughIfNeeded } from "@/lib/walkthrough-email";
import { NextResponse } from "next/server";

/**
 * GET /api/qbo/callback
 *
 * Receives the OAuth code + realmId from Intuit, exchanges for tokens,
 * fetches the real company name from QBO, and persists everything in client_links.
 *
 * Behavior:
 *  - If clientLinkId === "new":
 *      - Fetches CompanyInfo from QBO to get real company name + country
 *      - Upserts on qbo_realm_id so re-connecting the same QBO company
 *        UPDATES the existing row instead of duplicating or failing.
 *  - If clientLinkId is a specific row id: updates that row only.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const realmId = searchParams.get("realmId");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${origin}/dashboard?qbo_error=${error}`);
  }

  if (!code || !state || !realmId) {
    return NextResponse.redirect(`${origin}/dashboard?qbo_error=missing_params`);
  }

  // Verify CSRF state
  const cookieStore = request.headers.get("cookie") || "";
  const stateCookie = cookieStore
    .split(";")
    .map(c => c.trim())
    .find(c => c.startsWith("qbo_oauth_state="))
    ?.split("=")[1];

  const [stateValue, clientLinkId, userId] = state.split(".");

  if (!stateCookie || stateCookie !== stateValue) {
    return NextResponse.redirect(`${origin}/dashboard?qbo_error=csrf_mismatch`);
  }

  // Verify user is logged in and matches
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.id !== userId) {
    return NextResponse.redirect(`${origin}/dashboard?qbo_error=auth_mismatch`);
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Service role - bypasses RLS for token storage
    const serviceClient = createServiceSupabase();

    if (clientLinkId === "new") {
      // ============ NEW CONNECTION ============
      // Fetch the real company name from QBO (was missing — caused "QBO Company 12345" bug)
      let companyName = `QBO Company ${realmId}`;
      let companyJurisdiction: "US" | "CA" = "US";
      let stateProvince: string | null = null;
      let clientEmail: string | null = null;

      try {
        const info = await fetchCompanyInfo(realmId, tokens.access_token);
        companyName = info.CompanyName || info.LegalName || companyName;
        const countryRaw = (info.Country || info.CompanyAddr?.Country || "").toUpperCase();
        if (countryRaw === "CA" || countryRaw === "CANADA") companyJurisdiction = "CA";
        stateProvince = info.CompanyAddr?.CountrySubDivisionCode || null;
        clientEmail = info.PrimaryEmailAddr?.Address || null;
      } catch (e) {
        // Non-fatal: keep placeholder name, user can edit later from /clients
        console.error("[qbo/callback] fetchCompanyInfo failed:", e);
      }

      // Check if this realm is already linked
      const { data: existing } = await serviceClient
        .from("client_links")
        .select("id")
        .eq("qbo_realm_id", realmId)
        .maybeSingle();

      if (existing?.id) {
        // Re-authorization of an already-connected QBO company: refresh tokens + name only
        const { error: updateErr } = await serviceClient
          .from("client_links")
          .update({
            client_name: companyName,
            qbo_company_name: companyName,
            qbo_access_token: tokens.access_token,
            qbo_refresh_token: tokens.refresh_token,
            qbo_token_expires_at: expiresAt,
          })
          .eq("id", existing.id);

        if (updateErr) {
          return NextResponse.redirect(
            `${origin}/dashboard?qbo_error=${encodeURIComponent(updateErr.message)}`
          );
        }

        // Heal the Fleet QBO Health dashboard immediately — without
        // this the row stays at status=invalid_grant until the next
        // probe run, making reconnects look like they didn't take.
        await markQboConnectionHealthy(serviceClient as any, existing.id);

        return NextResponse.redirect(
          `${origin}/clients/${existing.id}?qbo_reauth=true`
        );
      }

      // Check if connecting user is a junior bookkeeper — auto-assign with 2-day due date
      const { data: connectingUser } = await serviceClient
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single();
      const isJunior = connectingUser?.role === "bookkeeper";
      const autoDueDate = isJunior
        ? new Date(Date.now() + 2 * 86400000).toISOString().split("T")[0]
        : null;

      // Fresh insert — new QBO company we've never seen before
      const { data: inserted, error: insertErr } = await serviceClient
        .from("client_links")
        .insert({
          client_name: companyName,
          qbo_company_name: companyName,
          qbo_realm_id: realmId,
          qbo_access_token: tokens.access_token,
          qbo_refresh_token: tokens.refresh_token,
          qbo_token_expires_at: expiresAt,
          jurisdiction: companyJurisdiction,
          state_province: stateProvince,
          client_email: clientEmail,
          double_client_id: `pending_${realmId}`,
          linked_by: user.id,
          ...(isJunior && {
            assigned_bookkeeper_id: user.id,
            due_date: autoDueDate,
          }),
        } as any)
        .select("id")
        .single();

      if (insertErr) {
        return NextResponse.redirect(
          `${origin}/dashboard?qbo_error=${encodeURIComponent(insertErr.message)}`
        );
      }

      // Seed the health row so first-time connects show as green right
      // away on /fleet/qbo-health instead of as "unknown" until the
      // probe runs.
      await markQboConnectionHealthy(serviceClient as any, inserted.id);

      // First QBO connect → send the client the SNAP walkthrough (once; no-ops
      // until the video URL env is set). Fail-soft so it never blocks the redirect.
      await sendWalkthroughIfNeeded(serviceClient as any, inserted.id).catch(() => {});

      // Land on the new client's workspace right after connecting.
      return NextResponse.redirect(
        `${origin}/clients/${inserted.id}?qbo_connected=true`
      );
    } else {
      // ============ EXISTING CLIENT, ADDING/REFRESHING QBO ============
      // (User had a client_link already and is connecting its QBO portion)
      let companyName: string | null = null;
      try {
        const info = await fetchCompanyInfo(realmId, tokens.access_token);
        companyName = info.CompanyName || info.LegalName || null;
      } catch (e) {
        console.error("[qbo/callback] fetchCompanyInfo failed:", e);
      }

      const updatePayload: Record<string, string> = {
        qbo_realm_id: realmId,
        qbo_access_token: tokens.access_token,
        qbo_refresh_token: tokens.refresh_token,
        qbo_token_expires_at: expiresAt,
      };
      if (companyName) updatePayload.qbo_company_name = companyName;

      const { error: updateErr } = await serviceClient
        .from("client_links")
        .update(updatePayload as any)
        .eq("id", clientLinkId);

      if (updateErr) {
        return NextResponse.redirect(
          `${origin}/dashboard?qbo_error=${encodeURIComponent(updateErr.message)}`
        );
      }

      await markQboConnectionHealthy(serviceClient as any, clientLinkId);

      // First QBO connect for this onboarding client → SNAP walkthrough email
      // (once; no-ops until the video URL env is set). Fail-soft.
      await sendWalkthroughIfNeeded(serviceClient as any, clientLinkId).catch(() => {});

      return NextResponse.redirect(`${origin}/dashboard?qbo_connected=true`);
    }
  } catch (err: any) {
    return NextResponse.redirect(
      `${origin}/dashboard?qbo_error=${encodeURIComponent(err.message)}`
    );
  }
}
