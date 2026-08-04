import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { resolvePortalContextAllowNoQbo } from "@/lib/portal-context";
import { noticePeriodLabel } from "@/lib/statement-notices";
import { noticeTablesMissing } from "@/lib/statement-notices-server";

/**
 * POST /api/portal/notices/[id]/reply   { body: string }
 *
 * The client's answer to a Notice to Reader. Three artifacts, in the ask-about
 * route's proven order — each later step fail-soft so the durable record always
 * exists:
 *   1. audit_log `statement_notice_reply` — the durable record, written first.
 *   2. client_communications from_client row WITH notice_id — this is what
 *      surfaces on /today's client inbox + unread badges, and what threads the
 *      reply to the notice it answers (the linkage ask-about never had).
 *   3. Email the notice's SENDER — deliberately narrow: SNAP's one internal
 *      notification email (Mike's explicit call, 2026-08-04; the standing rule
 *      is otherwise no internal email). Recipient resolution: live users row →
 *      sent_by_email snapshot (survives deactivated staff) → SUPPORT_INBOX.
 *      reply_to = the client, so the sender can answer straight from mail.
 *
 * Replying also acknowledges the notice — you necessarily read the version you
 * answered. Impersonating staff are blocked (admin previews must not create
 * client messages), matching ask-about/reclass-request.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: noticeId } = await context.params;

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
    return NextResponse.json({
      ok: true,
      delivered: "skipped_impersonating",
      message: "You're viewing as an admin (impersonating). Replies aren't sent in this mode.",
    });
  }

  const reqBody = await request.json().catch(() => ({}));
  const replyText = String(reqBody.body || "").trim().slice(0, 8000);
  if (!replyText) return NextResponse.json({ error: "Write a reply first." }, { status: 400 });

  const service = createServiceSupabase();
  const now = new Date().toISOString();

  try {
    const { data: notice } = await (service as any)
      .from("statement_notices")
      .select("id, client_link_id, period_year, period_month, sent_by, sent_by_name, sent_by_email, first_reply_at")
      .eq("id", noticeId)
      .maybeSingle();
    if (!notice || (notice as any).client_link_id !== ctx.clientLinkId) {
      return NextResponse.json({ error: "Notice not found" }, { status: 404 });
    }
    const periodLabel = noticePeriodLabel((notice as any).period_year, (notice as any).period_month);
    const subject = `Re: Notice to Reader — ${periodLabel}`;

    // 1. Durable record first.
    await (service as any).from("audit_log").insert({
      user_id: user.id,
      event_type: "statement_notice_reply",
      request_payload: {
        client_link_id: ctx.clientLinkId,
        client_name: ctx.clientName,
        notice_id: noticeId,
        period: `${(notice as any).period_year}-${String((notice as any).period_month).padStart(2, "0")}`,
        submitter_email: ctx.userEmail || user.email || null,
        reply: replyText,
      },
    });

    // 2. The team-visible message (fail-soft — the audit row above survives).
    let commDelivered = true;
    try {
      const { error } = await (service as any).from("client_communications").insert({
        client_link_id: ctx.clientLinkId,
        sender_user_id: user.id,
        direction: "from_client",
        kind: "message",
        subject,
        body: replyText,
        attachments: [],
        notice_id: noticeId,
      });
      if (error) throw error;
    } catch (e: any) {
      commDelivered = false;
      console.error(`[notice-reply] comms mirror failed: ${e?.message}`);
    }

    // 3. Email the sender (fail-soft; narrow one-off — see header).
    let emailDelivered = false;
    try {
      emailDelivered = await emailNoticeSenderAboutReply(service, {
        notice: notice as any,
        periodLabel,
        clientName: ctx.clientName,
        clientEmail: ctx.userEmail || user.email || "",
        replyText,
      });
    } catch (e: any) {
      console.error(`[notice-reply] sender email failed: ${e?.message}`);
    }

    // Stamp the notice + ack the receipt (replying implies reviewed).
    try {
      if (!(notice as any).first_reply_at) {
        await (service as any)
          .from("statement_notices")
          .update({ first_reply_at: now, updated_at: now })
          .eq("id", noticeId);
      }
      const { data: receipt } = await (service as any)
        .from("statement_notice_receipts")
        .select("id")
        .eq("notice_id", noticeId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (receipt) {
        await (service as any)
          .from("statement_notice_receipts")
          .update({ acknowledged_at: now, first_viewed_at: now, updated_at: now })
          .eq("id", (receipt as any).id);
      } else {
        await (service as any).from("statement_notice_receipts").insert({
          notice_id: noticeId,
          user_id: user.id,
          first_viewed_at: now,
          acknowledged_at: now,
        });
      }
    } catch { /* stamps are best-effort; the reply itself is already recorded */ }

    return NextResponse.json({
      ok: true,
      delivered: commDelivered ? (emailDelivered ? "inbox_and_email" : "inbox_only") : "audit_log_only",
      message: "Sent — your bookkeeping team will follow up.",
    });
  } catch (err: any) {
    if (noticeTablesMissing(err)) {
      return NextResponse.json({ error: "Notices aren't set up yet." }, { status: 503 });
    }
    console.error(`[notice-reply] ${noticeId}: ${err?.message}`);
    return NextResponse.json({ error: "Couldn't send the reply — try again." }, { status: 500 });
  }
}

/**
 * SNAP's one internal notification email. Kept as a named one-off — NOT a
 * general pattern; the standing rule (team awareness happens in-app) still
 * holds everywhere else.
 */
async function emailNoticeSenderAboutReply(
  service: any,
  params: {
    notice: { sent_by: string; sent_by_name: string | null; sent_by_email: string | null };
    periodLabel: string;
    clientName: string;
    clientEmail: string;
    replyText: string;
  }
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  // Live lookup → snapshot → support inbox. Never silently drop the reply.
  let to: string | null = null;
  try {
    const { data: sender } = await service
      .from("users")
      .select("email, is_active")
      .eq("id", params.notice.sent_by)
      .maybeSingle();
    if ((sender as any)?.email && (sender as any).is_active !== false) to = (sender as any).email;
  } catch { /* fall through */ }
  if (!to) to = params.notice.sent_by_email || null;
  if (!to) to = process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com";

  const from = process.env.RESEND_FROM || "Ironbooks <noreply@mail.ironbooks.com>";
  const subject = `${params.clientName} replied to your Notice to Reader (${params.periodLabel})`;
  const text = [
    `${params.clientName} replied to the ${params.periodLabel} Notice to Reader:`,
    ``,
    params.replyText,
    ``,
    `Reply to this email to answer them directly, or handle it from the client inbox on /today.`,
  ].join("\n");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      ...(params.clientEmail ? { reply_to: params.clientEmail } : {}),
    }),
  });
  return resp.ok;
}
