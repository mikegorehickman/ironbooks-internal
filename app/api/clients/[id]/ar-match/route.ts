import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { buildArMatchItems } from "@/lib/ar-match";
import { deliverClientEmail } from "@/lib/ask-client-email";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Staff side of client invoice-match sessions (migration 142).
 *
 * GET  → latest session for this client + its items (status panel).
 * POST { action: "preview" }
 *        → build the would-be items (open current-FY invoices + candidate
 *          deposits). Read-only; nothing stored, nothing sent.
 * POST { action: "create", auto_apply?: boolean, note?: string }
 *        → snapshot items into a session, cancel any prior open session,
 *          email the client a portal link. auto_apply (exact-candidate client
 *          confirmations write straight to QBO) is admin/lead only.
 * POST { action: "cancel" } → cancel the open session.
 */

async function requireStaff() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users").select("role, full_name, email").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, actor: actor as any, role, service };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireStaff();
  if ("error" in auth) return auth.error;
  const { id } = await context.params;

  const { data: session } = await (auth.service as any)
    .from("ar_match_sessions")
    .select("*")
    .eq("client_link_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!session) return NextResponse.json({ session: null, items: [] });

  const { data: items } = await (auth.service as any)
    .from("ar_match_items")
    .select("*")
    .eq("session_id", session.id)
    .order("txn_date", { ascending: true });
  return NextResponse.json({ session, items: items || [] });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireStaff();
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const { service, user, actor, role } = auth;

  const body = await request.json().catch(() => ({} as any));
  const action = String(body.action || "");

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, fiscal_year_end")
    .eq("id", id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if (action === "preview") {
    try {
      const items = await buildArMatchItems(service, client as any);
      return NextResponse.json({
        ok: true,
        count: items.length,
        with_candidates: items.filter((i) => i.candidates.length > 0).length,
        exact_eligible: items.filter((i) => i.candidates.some((c) => c.exact_eligible)).length,
        total_balance: Math.round(items.reduce((s, i) => s + (i.balance || 0), 0) * 100) / 100,
        items,
      });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Preview failed" }, { status: 502 });
    }
  }

  if (action === "cancel") {
    await (service as any)
      .from("ar_match_sessions")
      .update({ status: "cancelled" })
      .eq("client_link_id", id)
      .eq("status", "open");
    return NextResponse.json({ ok: true });
  }

  if (action === "create") {
    const autoApply = body.auto_apply === true;
    if (autoApply && !["admin", "lead"].includes(role)) {
      return NextResponse.json(
        { error: "Only admin/lead can enable auto-apply." },
        { status: 403 }
      );
    }

    let items;
    try {
      items = await buildArMatchItems(service, client as any);
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Couldn't build items" }, { status: 502 });
    }
    if (items.length === 0) {
      return NextResponse.json(
        { error: "No open current-fiscal-year invoices — nothing to send." },
        { status: 400 }
      );
    }

    // One open session per client — a stale list in the portal is worse
    // than no list.
    await (service as any)
      .from("ar_match_sessions")
      .update({ status: "cancelled" })
      .eq("client_link_id", id)
      .eq("status", "open");

    const { data: session, error: sErr } = await (service as any)
      .from("ar_match_sessions")
      .insert({
        client_link_id: id,
        created_by: user.id,
        status: "open",
        auto_apply: autoApply,
        note: (body.note || "").toString().slice(0, 500) || null,
      })
      .select("*")
      .single();
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });

    const rows = items.map((i) => ({
      session_id: session.id,
      client_link_id: id,
      qbo_invoice_id: i.qbo_invoice_id,
      doc_number: i.doc_number,
      customer_name: i.customer_name,
      txn_date: i.txn_date,
      amount: i.amount,
      balance: i.balance,
      candidates: i.candidates as any,
    }));
    const { error: iErr } = await (service as any).from("ar_match_items").insert(rows);
    if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });

    // Branded email with the portal link. Failure to send is non-fatal — the
    // portal badge still surfaces the session next login.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://snap.ironbooks.com";
    const link = `${appUrl}/portal/invoice-check`;
    const clientName = (client as any).client_name || "your business";
    const text =
      `Hi there,\n\nWhile keeping ${clientName}'s books accurate we found ${items.length} ` +
      `invoice${items.length === 1 ? "" : "s"} in QuickBooks that still show as unpaid. ` +
      `Often these were actually paid — the payment just never got connected to the invoice.\n\n` +
      `Could you take 2 minutes to confirm what happened with each one? We've lined up likely ` +
      `matches, so most are a single tap:\n\n${link}\n\nThank you!`;
    const html = `<div style="font-family:'Figtree',Helvetica,Arial,sans-serif;color:#152F46;max-width:640px;margin:0 auto;">
  <div style="background:#152F46;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-size:19px;font-weight:700;">Ironbooks</div>
  <div style="border:1px solid #CBD4DC;border-top:none;padding:22px 20px;border-radius:0 0 10px 10px;">
    <p style="line-height:1.55;margin:0 0 14px 0;">Hi there,</p>
    <p style="line-height:1.55;margin:0 0 14px 0;">While keeping <strong>${clientName}</strong>'s books accurate we found <strong>${items.length} invoice${items.length === 1 ? "" : "s"}</strong> in QuickBooks that still show as unpaid. Often these were actually paid — the payment just never got connected to the invoice.</p>
    <p style="line-height:1.55;margin:0 0 18px 0;">Could you take 2 minutes to confirm what happened with each one? We've lined up likely matches, so most are a single tap.</p>
    <p style="margin:0 0 18px 0;"><a href="${link}" style="background:#3E908D;color:#fff;text-decoration:none;font-weight:700;padding:11px 22px;border-radius:8px;display:inline-block;">Review your invoices</a></p>
    <p style="line-height:1.55;margin:0;color:#5B6672;font-size:13px;">Thank you! — the Ironbooks team</p>
  </div>
</div>`;
    const sent = await deliverClientEmail({
      service,
      clientLinkId: id,
      clientName,
      userId: user.id,
      actor,
      subject: `Quick check: ${items.length} invoice${items.length === 1 ? "" : "s"} to confirm — ${clientName}`,
      html,
      text,
      emailType: "invoice_check",
      auditEventType: "ar_match_session_sent",
      auditExtra: { session_id: session.id, item_count: items.length, auto_apply: autoApply },
    });

    return NextResponse.json({
      ok: true,
      session_id: session.id,
      items: items.length,
      auto_apply: autoApply,
      email_sent: sent.ok,
      email_error: sent.ok ? undefined : (sent.body as any)?.error,
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
