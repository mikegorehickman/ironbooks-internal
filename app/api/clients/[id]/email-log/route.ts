import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/email-log?type=bs_statements&limit=5
 *
 * Recent client-facing emails we've logged for this client (from
 * client_email_log). Delivery status is kept live by the Resend webhook
 * (sent → delivered → opened / bounced). Read-only; staff roles.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper", "viewer"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const type = (searchParams.get("type") || "").trim();
  const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit")) || 5));

  let query = (service as any)
    .from("client_email_log")
    .select("id, email_type, subject, to_address, status, provider_message_id, error, created_at, delivered_at, opened_at, clicked_at")
    .eq("client_link_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (type) query = query.eq("email_type", type);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ emails: data || [] });
}
