import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { resolveFromEmail } from "@/lib/email-sender";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/support — client portal support ticket submission.
 *
 * Submitted from the floating Help widget in app/portal/support-widget.tsx.
 * Two-track delivery so a ticket is never silently lost:
 *
 *   1. Email via Resend HTTP API → admin@ironbooks.com (the destination
 *      Mike asked for). Uses raw fetch against api.resend.com to avoid
 *      pulling in another SDK dependency. Requires RESEND_API_KEY env
 *      var; if absent we log loudly and rely on the audit_log fallback.
 *      The `from` address defaults to Resend's onboarding sender so
 *      tickets ship immediately even before a custom domain is verified
 *      — Mike can override with SUPPORT_FROM_EMAIL once ironbooks.com
 *      domain auth is set up in Resend.
 *
 *   2. audit_log row (event_type=portal_support_ticket) — durable,
 *      queryable from /admin/audit. Always written, regardless of email
 *      outcome. Doubles as a triage queue if email delivery breaks.
 *
 * Auth: must be inside a resolved portal context (real client OR admin
 * impersonating). Internal users not impersonating can't submit — they
 * have other tools.
 *
 * Note: we send a single email per request — no rate limiting yet because
 * (a) submission is gated to authenticated portal users, (b) tickets are
 * already throttled by human typing speed. Add rate limiting if spam
 * becomes an issue.
 */
export async function POST(request: Request) {
  // Auth guard — must be in a portal context
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json(
      { error: "No portal context — support is available from the client portal only." },
      { status: 403 }
    );
  }
  const ctx = ctxResult.ctx;

  // Parse + validate payload
  let body: { subject?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subject = (body.subject || "").trim().slice(0, 200);
  const message = (body.message || "").trim().slice(0, 4000);

  if (!message) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const submittedAt = new Date().toISOString();

  // Persist FIRST — if email delivery fails we still have the ticket
  await service.from("audit_log").insert({
    event_type: "portal_support_ticket",
    user_id: user.id,
    request_payload: {
      client_link_id: ctx.clientLinkId,
      client_name: ctx.clientName,
      submitter_email: ctx.userEmail,
      submitter_full_name: ctx.userFullName,
      impersonating: ctx.impersonating,
      real_user_name: ctx.realUserName || null,
      subject: subject || "(no subject)",
      message,
      submitted_at: submittedAt,
    } as any,
  });

  // Mirror into client_communications so the ticket shows up in the
  // bookkeeper's /today inbox + the client's message thread (audit_log +
  // email alone are invisible in-app). Best-effort: the audit row above
  // is the durable record. Skipped while impersonating — test tickets
  // shouldn't land in the real inbox.
  if (!ctx.impersonating) {
    try {
      await (service as any).from("client_communications").insert({
        client_link_id: ctx.clientLinkId,
        sender_user_id: user.id,
        direction: "from_client",
        kind: "message",
        body: `🛟 Support: ${subject || "(no subject)"}\n\n${message}`.slice(0, 8000),
        attachments: [],
      });
    } catch (commErr) {
      console.warn("[support] client_communications mirror failed:", commErr);
    }
  }

  // Email via Resend
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = resolveFromEmail(process.env.SUPPORT_FROM_EMAIL);
  const toEmail = process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com";

  if (!apiKey) {
    // Fail soft — ticket is already in audit_log, so the data isn't lost.
    // Bookkeeper will see it next time they check /admin/audit. Loud warn
    // so this shows up in Vercel logs as a TODO for Mike.
    console.warn(
      "[support] RESEND_API_KEY not set — ticket persisted to audit_log but no email sent. " +
        `Ticket from ${ctx.userEmail} (${ctx.clientName}).`
    );
    return NextResponse.json({
      ok: true,
      delivered: "audit_log_only",
      message: "Ticket received. (Email delivery is being configured.)",
    });
  }

  // Plain-text body composed for readability when bookkeeper opens in
  // any mail client. Subject line tagged so it filters/threads cleanly.
  const emailSubject = `[Ironbooks Support] ${subject || "New ticket"} — ${ctx.clientName}`;
  const replyTo = ctx.userEmail; // hitting "Reply" lands directly with the client

  const emailBody = [
    `New support ticket from the Ironbooks client portal.`,
    ``,
    `Client:          ${ctx.clientName}`,
    `Submitted by:    ${ctx.userFullName || "(no name)"} <${ctx.userEmail}>`,
    ctx.impersonating ? `Impersonated by: ${ctx.realUserName || "Admin"}` : null,
    `Submitted:       ${submittedAt}`,
    ``,
    `Subject: ${subject || "(no subject)"}`,
    ``,
    `Message:`,
    `--------`,
    message,
    `--------`,
    ``,
    `Reply directly to this email — it will reach ${ctx.userEmail}.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: replyTo,
        subject: emailSubject,
        text: emailBody,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error(
        `[support] Resend send failed: ${resendRes.status} ${errText} (ticket from ${ctx.userEmail})`
      );
      // Still 200 to the client — their ticket IS persisted. Pretending
      // it failed would just make them retry and create duplicates in the
      // audit log.
      return NextResponse.json({
        ok: true,
        delivered: "audit_log_only",
        message: "Ticket received. Our team will reach out shortly.",
      });
    }

    return NextResponse.json({
      ok: true,
      delivered: "email_and_audit_log",
      message: "Ticket sent successfully.",
    });
  } catch (err: any) {
    console.error(
      `[support] Resend network error: ${err?.message} (ticket from ${ctx.userEmail})`
    );
    return NextResponse.json({
      ok: true,
      delivered: "audit_log_only",
      message: "Ticket received. Our team will reach out shortly.",
    });
  }
}
