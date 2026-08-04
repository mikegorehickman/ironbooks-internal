import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { parseRunPeriod, receiptSummary } from "@/lib/statement-notices";
import { fetchNoticeForPeriod } from "@/lib/statement-notices-server";

/**
 * GET /api/clients/[id]/notice-status?period=YYYY-MM   (READ-ONLY, staff)
 *
 * Has the client actually SEEN the month's Notice to Reader? One line for the
 * rec-card's sent state and the client profile: "acknowledged by N of M portal
 * users" / "unviewed for D days" / "no portal logins yet". Ack counts respect
 * the resend rule (acknowledged_at >= sent_at), so a re-sent notice reads
 * unviewed again until people re-acknowledge.
 *
 * Owner bookkeeper or admin/lead.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let year: number, month: number;
  try {
    ({ year, month } = parseRunPeriod(new URL(request.url).searchParams.get("period") || ""));
  } catch {
    return NextResponse.json({ error: "period must be YYYY-MM" }, { status: 400 });
  }

  try {
    const notice = await fetchNoticeForPeriod(service, clientLinkId, year, month);
    if (!notice) return NextResponse.json({ notice: null });

    const [{ data: receipts }, { data: portalUsers }] = await Promise.all([
      (service as any)
        .from("statement_notice_receipts")
        .select("first_viewed_at, acknowledged_at")
        .eq("notice_id", notice.id),
      service.from("client_users" as any).select("user_id").eq("client_link_id", clientLinkId).eq("active", true),
    ]);
    const summary = receiptSummary(receipts || [], (portalUsers || []).length, notice, Date.now());

    return NextResponse.json({
      notice: {
        id: notice.id,
        sent_at: notice.sent_at,
        sent_by_name: notice.sent_by_name,
        resend_count: notice.resend_count,
        first_reply_at: notice.first_reply_at,
      },
      summary,
    });
  } catch (e: any) {
    // Pre-migration environments read as "no notice" rather than erroring.
    return NextResponse.json({ notice: null });
  }
}
