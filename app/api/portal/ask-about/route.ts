import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { resolveFromEmail } from "@/lib/email-sender";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/ask-about — "Ask Ironbooks about this" submission.
 *
 * The portal facelift adds a small "Ask about this" affordance on every
 * financial surface: a P&L line, a Balance Sheet line, an individual
 * transaction, an A/R customer, an A/P vendor — or a whole-page summary.
 * The client types a plain-English question ("Why is this categorized as
 * overhead?", "Is this amount right?") and it lands with their Ironbooks
 * team.
 *
 * Delivery mirrors /api/portal/support — two tracks so a question is never
 * silently lost:
 *
 *   1. audit_log row (event_type=portal_categorization_question) — durable,
 *      queryable from /admin/audit, written FIRST. Doubles as the triage
 *      queue when email isn't configured.
 *   2. Email via Resend → admin@ironbooks.com. Requires RESEND_API_KEY;
 *      when absent we fail soft (ticket is already persisted) and report
 *      delivered: "audit_log_only" so the UI can still say "received".
 *
 * Auth: must be inside a resolved portal context. Submissions are BLOCKED
 * while an admin is impersonating so test questions don't reach the queue.
 */

const KINDS = [
  "pl_line",
  "bs_line",
  "transaction",
  "ar_customer",
  "ap_vendor",
  "pl_summary",
  "bs_summary",
] as const;
type AskKind = (typeof KINDS)[number];

const KIND_LABEL: Record<AskKind, string> = {
  pl_line: "P&L line",
  bs_line: "Balance Sheet line",
  transaction: "Transaction",
  ar_customer: "Customer (A/R)",
  ap_vendor: "Vendor (A/P)",
  pl_summary: "Profit & Loss",
  bs_summary: "Balance Sheet",
};

export async function POST(request: Request) {
  // Auth guard — must have a session
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json(
      { error: "No portal context — this is available from the client portal only." },
      { status: 403 }
    );
  }
  const ctx = ctxResult.ctx;

  // Block while impersonating — admin previews shouldn't generate real questions
  if (ctx.impersonating) {
    return NextResponse.json(
      {
        ok: true,
        delivered: "skipped_impersonating",
        message:
          "You're viewing as an admin (impersonating). Questions aren't sent in this mode.",
      },
      { status: 200 }
    );
  }

  let body: {
    kind?: string;
    label?: string;
    amount?: number;
    period?: string;
    question?: string;
    context?: Record<string, any>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const kind = (KINDS as readonly string[]).includes(body.kind || "")
    ? (body.kind as AskKind)
    : "pl_line";
  const label = (body.label || "").trim().slice(0, 200);
  const question = (body.question || "").trim().slice(0, 4000);
  const period = (body.period || "").trim().slice(0, 120);
  const amount = typeof body.amount === "number" && Number.isFinite(body.amount) ? body.amount : null;
  const context = body.context && typeof body.context === "object" ? body.context : {};

  if (!question) {
    return NextResponse.json({ error: "A question is required." }, { status: 400 });
  }

  const service = createServiceSupabase();
  const submittedAt = new Date().toISOString();

  // Persist FIRST
  await service.from("audit_log").insert({
    event_type: "portal_categorization_question",
    user_id: user.id,
    request_payload: {
      client_link_id: ctx.clientLinkId,
      client_name: ctx.clientName,
      submitter_email: ctx.userEmail,
      submitter_full_name: ctx.userFullName,
      kind,
      kind_label: KIND_LABEL[kind],
      item_label: label || null,
      amount,
      period: period || null,
      question,
      context,
      submitted_at: submittedAt,
    } as any,
  });

  // Mirror into client_communications so the question shows up in the
  // bookkeeper's /today inbox + the client's message thread. Without this
  // the question only lives in audit_log (+ maybe email) and the
  // bookkeeper never sees it in-app. Best-effort: the audit row above is
  // the durable record, so a failure here must not fail the request.
  try {
    const ctxLines = Object.entries(context as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    const commBody = [
      `❓ Question about ${KIND_LABEL[kind]}${label ? ` — ${label}` : ""}`,
      amount != null ? `Amount: $${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
      period ? `Period: ${period}` : null,
      ...(ctxLines.length ? ctxLines : []),
      ``,
      question,
    ]
      .filter((l) => l !== null)
      .join("\n");
    await (service as any).from("client_communications").insert({
      client_link_id: ctx.clientLinkId,
      sender_user_id: user.id,
      direction: "from_client",
      kind: "message",
      body: commBody.slice(0, 8000),
      attachments: [],
    });
  } catch (commErr) {
    console.warn("[ask-about] client_communications mirror failed:", commErr);
  }

  // Email via Resend (best-effort)
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = resolveFromEmail(process.env.SUPPORT_FROM_EMAIL);
  const toEmail = process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com";

  if (!apiKey) {
    console.warn(
      "[ask-about] RESEND_API_KEY not set — question persisted to audit_log but no email sent. " +
        `From ${ctx.userEmail} (${ctx.clientName}) about ${KIND_LABEL[kind]}: ${label}`
    );
    return NextResponse.json({
      ok: true,
      delivered: "audit_log_only",
      message: "Your question is on its way to the Ironbooks team.",
    });
  }

  const subjectBits = [KIND_LABEL[kind], label].filter(Boolean).join(" · ");
  const emailSubject = `[Ironbooks Portal Q] ${subjectBits} — ${ctx.clientName}`;

  const contextLines = Object.entries(context)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);

  const emailBody = [
    `A client asked a question from their Ironbooks portal.`,
    ``,
    `Client:        ${ctx.clientName}`,
    `Asked by:      ${ctx.userFullName || "(no name)"} <${ctx.userEmail}>`,
    `Submitted:     ${submittedAt}`,
    ``,
    `About:         ${KIND_LABEL[kind]}${label ? ` — ${label}` : ""}`,
    amount != null ? `Amount:        ${fmtMoney(amount)}` : null,
    period ? `Period:        ${period}` : null,
    contextLines.length ? `Details:` : null,
    ...(contextLines.length ? contextLines : []),
    ``,
    `Question:`,
    `---------`,
    question,
    `---------`,
    ``,
    `Reply directly to this email — it will reach ${ctx.userEmail}.`,
  ]
    .filter((l) => l !== null)
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
        reply_to: ctx.userEmail,
        subject: emailSubject,
        text: emailBody,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error(
        `[ask-about] Resend send failed: ${resendRes.status} ${errText} (from ${ctx.userEmail})`
      );
      return NextResponse.json({
        ok: true,
        delivered: "audit_log_only",
        message: "Your question was received — the Ironbooks team will follow up.",
      });
    }

    return NextResponse.json({
      ok: true,
      delivered: "email_and_audit_log",
      message: "Sent to your Ironbooks team.",
    });
  } catch (err: any) {
    console.error(`[ask-about] Resend network error: ${err?.message} (from ${ctx.userEmail})`);
    return NextResponse.json({
      ok: true,
      delivered: "audit_log_only",
      message: "Your question was received — the Ironbooks team will follow up.",
    });
  }
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return (
    sign +
    abs.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })
  );
}
