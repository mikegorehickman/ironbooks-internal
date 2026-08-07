/**
 * Canonical registry of client-portal pages that can be granted / withheld
 * per portal user (client_users.allowed_pages).
 *
 * Semantics of client_users.allowed_pages:
 *   - NULL        → full access (every page) — the default, and what every
 *                   user provisioned before migration 154 has.
 *   - TEXT[] keys → only the listed pages, PLUS the always-allowed routes
 *                   below (Overview, Settings, Onboarding).
 *
 * This file is imported by the middleware (edge), server layouts/routes and
 * client components — keep it dependency-free.
 */

export interface PortalPageDef {
  /** Stable key stored in client_users.allowed_pages. Never rename. */
  key: string;
  /** Label shown in the staff-side multi-select (mirrors the sidebar). */
  label: string;
  /** Sidebar section, for grouping the multi-select the same way. */
  section: "Finances" | "Your books" | "Help & learning" | "Account";
  /** Route prefixes this page owns (deep routes included via prefix match). */
  prefixes: string[];
}

export const PORTAL_PAGES: PortalPageDef[] = [
  {
    key: "financial_statements",
    label: "Financial Statements",
    section: "Finances",
    // Owns the hub + the three statements + published monthly statements.
    prefixes: [
      "/portal/financial-statements",
      "/portal/profit-loss",
      "/portal/balance-sheet",
      "/portal/cash-flow",
      "/portal/statements",
    ],
  },
  { key: "whos_paying", label: "Who owes you", section: "Finances", prefixes: ["/portal/whos-paying"] },
  { key: "whats_due", label: "What you owe", section: "Finances", prefixes: ["/portal/whats-due"] },
  { key: "categorize", label: "Categorize", section: "Your books", prefixes: ["/portal/categorize"] },
  { key: "cleanup_reports", label: "Cleanup Reports", section: "Your books", prefixes: ["/portal/cleanup-reports"] },
  { key: "messages", label: "Messages", section: "Help & learning", prefixes: ["/portal/messages"] },
  { key: "ask_ai", label: "Ask the AI", section: "Help & learning", prefixes: ["/portal/ask-ai"] },
  { key: "knowledge_base", label: "Knowledge Base", section: "Help & learning", prefixes: ["/portal/knowledge-base"] },
  { key: "learn", label: "Learn", section: "Help & learning", prefixes: ["/portal/learn"] },
  { key: "coaching_call", label: "Book a coaching call", section: "Help & learning", prefixes: ["/portal/coaching-call"] },
  { key: "billing", label: "Billing & Plan", section: "Account", prefixes: ["/portal/billing"] },
];

export const PORTAL_PAGE_KEYS: string[] = PORTAL_PAGES.map((p) => p.key);

/**
 * Routes every portal user can always reach, no matter the selection:
 *   - /portal            (Overview — the landing page; hiding it would strand users)
 *   - /portal/settings   (their own account settings)
 *   - /portal/onboarding (the setup wizard must never be blocked)
 */
export const ALWAYS_ALLOWED_PREFIXES = ["/portal/settings", "/portal/onboarding"];

/** Labels for the always-on pages, so UIs can show them as locked-on. */
export const ALWAYS_ALLOWED_LABELS = ["Overview", "Settings"];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * Server-side page gate. `allowed` is client_users.allowed_pages:
 * NULL/undefined → everything allowed. Unknown /portal sub-routes are
 * DENIED for restricted users (fail closed) — when a new portal page
 * ships, register it above so restricted users can be granted it.
 */
export function isPortalPathAllowed(
  allowed: string[] | null | undefined,
  pathname: string
): boolean {
  if (!allowed) return true; // NULL = full access

  // Normalize: strip a single trailing slash ("/portal/learn/" → "/portal/learn")
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (path === "/portal") return true; // Overview always
  if (ALWAYS_ALLOWED_PREFIXES.some((p) => matchesPrefix(path, p))) return true;

  const page = PORTAL_PAGES.find((pg) => pg.prefixes.some((pre) => matchesPrefix(path, pre)));
  if (page) return allowed.includes(page.key);

  return false; // unregistered portal route + restricted user → deny
}

/**
 * Sanitize a client-supplied allowed_pages payload into what we store:
 *   - not an array            → null (full access)
 *   - contains every key      → null (full access — keeps NULL the canonical
 *                               "everything" so future pages are auto-granted)
 *   - otherwise               → deduped array of the valid keys (may be empty:
 *                               that user only gets Overview + Settings)
 */
export function sanitizeAllowedPages(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const valid = Array.from(
    new Set(input.filter((k): k is string => typeof k === "string" && PORTAL_PAGE_KEYS.includes(k)))
  );
  if (valid.length >= PORTAL_PAGE_KEYS.length) return null;
  return valid;
}
