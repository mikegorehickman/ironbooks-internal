import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isPortalPathAllowed } from "@/lib/portal-pages";

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
      // Per-user page permissions (client_users.allowed_pages). This is the
      // SERVER-SIDE gate — the sidebar hides blocked links, but a typed URL
      // must also bounce. Overview/Settings/Onboarding are always allowed;
      // NULL allowed_pages = full access, so this only ever costs a second
      // query for users who actually have restrictions… and one lookup for
      // everyone else. Blocked page → back to /portal (Overview).
      if (isPortal && pathname !== "/portal") {
        const allowedPages = await lookupAllowedPages(user.id);
        if (!isPortalPathAllowed(allowedPages, pathname)) {
          const url = request.nextUrl.clone();
          url.pathname = "/portal";
          return NextResponse.redirect(url);
        }
      }
    } else {
      // Internal staff: bounce them OUT of /portal/* — UNLESS they have
      // the impersonation cookie set (admin/lead only path). The portal
      // layout + resolvePortalContext re-validate everything; middleware
      // just opens the gate.
      const isImpersonating =
        (role === "admin" || role === "lead") &&
        !!request.cookies.get("snap_impersonate_user_id")?.value;
      if (isPortal && !isImpersonating) {
        const url = request.nextUrl.clone();
        url.pathname = "/today";
        return NextResponse.redirect(url);
      }
      if (isRoot) {
        // Today is the internal home — the daily command center every
        // staff member should land on after login.
        const url = request.nextUrl.clone();
        url.pathname = "/today";
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

/**
 * Fetch the client user's page permissions (client_users.allowed_pages).
 * Returns null for "full access" — including on any error (e.g. migration
 * 154 not applied yet), so the portal never breaks for unrestricted users.
 */
async function lookupAllowedPages(userId: string): Promise<string[] | null> {
  try {
    const svc = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data, error } = await svc
      .from("client_users")
      .select("allowed_pages")
      .eq("user_id", userId)
      .eq("active", true)
      .maybeSingle();
    if (error) return null;
    const pages = (data as any)?.allowed_pages;
    return Array.isArray(pages) ? pages : null;
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$).*)"],
};
