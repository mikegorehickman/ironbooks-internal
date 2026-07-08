import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isV2For, isArchivedRoute } from "@/lib/feature-flags";

/**
 * Routing rules (with client portal):
 *
 *   Unauthenticated:
 *     - public routes  → through
 *     - everything else → /auth/login
 *
 *   Authenticated as client (role='client'):
 *     - /portal/*       → through
 *     - /auth/login     → /portal
 *     - anything else   → /portal (no bookkeeper-side routes for clients)
 *
 *   Authenticated as internal staff (admin/lead/bookkeeper/viewer):
 *     - /portal/*       → /dashboard (no client-side routes for staff —
 *                         they preview via the mockup or impersonation tools)
 *     - /auth/login     → /dashboard
 *     - everything else → through
 *
 * The role lookup uses the service-role client (RLS bypass) so we can read
 * `users.role` without depending on a per-row policy.
 */
export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Do not run code between createServerClient and getUser.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  const publicRoutes = ["/auth/login", "/auth/callback", "/stripe-connect"];
  const isPublic = publicRoutes.some((p) => pathname.startsWith(p));
  const isApi = pathname.startsWith("/api/");
  const isStatic =
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/.test(pathname);

  // Portal mockup is open during the design-review phase. Once the real
  // /portal lands and the mockup is retired, this carve-out comes out.
  const isPortalMockup = pathname.startsWith("/portal-mockup");

  if (!user && !isPublic && !isApi && !isStatic && !isPortalMockup) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/auth/login") {
    // Will dispatch to /portal or /dashboard based on role — handled below.
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Role-gated routing — only meaningful for authenticated users on
  // non-API, non-static, non-public routes.
  if (user && !isApi && !isStatic && !isPublic) {
    const role = await lookupRole(user.id);
    const isPortal = pathname.startsWith("/portal") && !isPortalMockup;
    const isRoot = pathname === "/";

    // Billing admin: a restricted internal role that can ONLY see the billing
    // page — no client bookkeeping. Confine them to /admin/billing; everything
    // else (including / and /dashboard) bounces there. (APIs are gated
    // separately: requireStaff rejects this role, and the billing endpoints
    // explicitly allow it.)
    if (role === "billing_admin") {
      // Billing + the revenue-facing Upgrade Radar (same persona: revenue, no
      // client bookkeeping). Everything else bounces to billing.
      if (!pathname.startsWith("/admin/billing") && !pathname.startsWith("/admin/upgrades")) {
        const url = request.nextUrl.clone();
        url.pathname = "/admin/billing";
        return NextResponse.redirect(url);
      }
      return supabaseResponse;
    }

    if (role === "client") {
      // Clients are confined to /portal/* (and the mockup during preview).
      // Any other route — including / and /dashboard — gets pushed to /portal.
      if (!isPortal && !isPortalMockup) {
        const url = request.nextUrl.clone();
        url.pathname = "/portal";
        return NextResponse.redirect(url);
      }
    } else {
      // V2 (site simplification) flips the staff home to /home and archives
      // unused tools. Both are no-ops for V1 users.
      const v2 = isV2For(user.email);
      const staffHome = v2 ? "/home" : "/today";

      // Internal staff: bounce them OUT of /portal/* — UNLESS they have
      // the impersonation cookie set (admin/lead only path). The portal
      // layout + resolvePortalContext re-validate everything; middleware
      // just opens the gate.
      const isImpersonating =
        (role === "admin" || role === "lead") &&
        !!request.cookies.get("snap_impersonate_user_id")?.value;
      if (isPortal && !isImpersonating) {
        const url = request.nextUrl.clone();
        url.pathname = staffHome;
        return NextResponse.redirect(url);
      }

      // V2 archives unused tools: a V2 user landing on an archived route sees
      // the "archived" notice instead. The route + its data are untouched —
      // an admin can re-enable. V1 users reach the tool normally.
      if (v2 && isArchivedRoute(pathname)) {
        const url = request.nextUrl.clone();
        url.pathname = "/archived";
        url.search = `?from=${encodeURIComponent(pathname)}`;
        return NextResponse.rewrite(url);
      }

      if (isRoot) {
        // The daily command center every staff member lands on after login.
        const url = request.nextUrl.clone();
        url.pathname = staffHome;
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}

/**
 * Cheap one-shot role lookup. Service client = bypasses RLS so this works
 * even before per-table client policies are wired up. Cached results are
 * not worth the complexity at our scale — the round-trip is fast.
 */
async function lookupRole(userId: string): Promise<string | null> {
  try {
    const svc = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data } = await svc.from("users").select("role").eq("id", userId).single();
    return (data as any)?.role ?? null;
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$).*)"],
};
