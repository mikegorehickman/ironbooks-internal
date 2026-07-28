import { NextResponse } from "next/server";
import { SKIP_QBO_COOKIE } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/portal/skip-qbo — "skip for now" from the QuickBooks-expired screen.
 *
 * A dead QBO token used to be a hard dead end: the portal was replaced by the
 * reconnect card, so the client couldn't reach their messages, their already-
 * published statements, or their billing. This sets a short-lived cookie that
 * lets them into the portal in degraded mode (a persistent banner still asks
 * them to reconnect, and live-QuickBooks views prompt individually).
 *
 * Plain GET so the button is a link — no JS needed on that screen.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Only ever bounce somewhere inside the portal — never an open redirect.
  const raw = url.searchParams.get("to") || "/portal";
  const to = raw.startsWith("/portal") ? raw : "/portal";

  const res = NextResponse.redirect(new URL(to, url.origin));
  res.cookies.set(SKIP_QBO_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h — long enough for a session, short enough to re-nag
  });
  return res;
}
