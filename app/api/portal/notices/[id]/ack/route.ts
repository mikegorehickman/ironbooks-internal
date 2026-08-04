import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { resolvePortalContextAllowNoQbo } from "@/lib/portal-context";
import { noticeTablesMissing } from "@/lib/statement-notices-server";

/**
 * POST /api/portal/notices/[id]/ack   { mode: "viewed" | "ack" }
 *
 * Per-USER receipt stamping for a Notice to Reader:
 *   viewed — the modal opened in front of this user (analytics + "unviewed for
 *            N days" on the team side). Stamped once per notice version.
 *   ack    — "I've reviewed this". Whether it counts is judged against the
 *            notice's sent_at (re-sends bump it), so we just stamp now().
 *
 * Uses the AllowNoQbo context: a dead QuickBooks token must never stop a client
 * from acknowledging a notice (portal-context.ts lists exactly this class).
 * Impersonating staff get 200 {skipped_impersonating} — their ids aren't in
 * client_users, and junk receipts would corrupt the N-of-M ack reporting.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: noticeId } = await context.params;

  // Receipts key on the SESSION user's id — the AllowNoQbo degraded context
  // deliberately blanks ctx.userId, so identity comes straight from auth.
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await resolvePortalContextAllowNoQbo();
  if (!res.ok) {
    return NextResponse.json({ error: res.message, code: res.code },
      { status: res.code === "no_session" ? 401 : 403 });
  }
  const ctx = res.ctx;
  if (ctx.impersonating) {
    return NextResponse.json({ ok: true, skipped_impersonating: true });
  }

  const body = await request.json().catch(() => ({}));
  const mode = body.mode === "ack" ? "ack" : "viewed";
  const service = createServiceSupabase();
  const now = new Date().toISOString();

  try {
    // The notice must belong to THIS portal user's client — never trust the id.
    const { data: notice } = await (service as any)
      .from("statement_notices")
      .select("id, client_link_id, sent_at")
      .eq("id", noticeId)
      .maybeSingle();
    if (!notice || (notice as any).client_link_id !== ctx.clientLinkId) {
      return NextResponse.json({ error: "Notice not found" }, { status: 404 });
    }

    const patch: any = { updated_at: now };
    if (mode === "ack") patch.acknowledged_at = now;

    const { data: existing } = await (service as any)
      .from("statement_notice_receipts")
      .select("id, first_viewed_at")
      .eq("notice_id", noticeId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing) {
      // "viewed" re-stamps ONLY when the existing stamp predates the current
      // version (a re-send bumped sent_at) — repeat opens of the same version
      // keep the original first-view, which is what "first" means.
      const seen = (existing as any).first_viewed_at
        ? Date.parse((existing as any).first_viewed_at)
        : NaN;
      const sentAt = Date.parse((notice as any).sent_at);
      const staleView = !Number.isFinite(seen) || (Number.isFinite(sentAt) && seen < sentAt);
      if (mode === "viewed" && staleView) patch.first_viewed_at = now;
      // An ack necessarily implies a view of the current version.
      if (mode === "ack" && staleView) patch.first_viewed_at = now;
      const { error } = await (service as any)
        .from("statement_notice_receipts")
        .update(patch)
        .eq("id", (existing as any).id);
      if (error) throw error;
    } else {
      const { error } = await (service as any).from("statement_notice_receipts").insert({
        notice_id: noticeId,
        user_id: user.id,
        first_viewed_at: now,
        acknowledged_at: mode === "ack" ? now : null,
      });
      if (error) throw error;
    }

    return NextResponse.json({ ok: true, mode });
  } catch (err: any) {
    if (noticeTablesMissing(err)) {
      return NextResponse.json({ ok: true, setup_pending: true });
    }
    console.error(`[notice-ack] ${noticeId}: ${err?.message}`);
    return NextResponse.json({ error: "Couldn't record that — try again." }, { status: 500 });
  }
}
