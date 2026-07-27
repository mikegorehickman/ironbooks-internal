import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/admin/bulk-email/campaigns — admin/lead. Recent campaigns + counts. */
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Senior access required" }, { status: 403 });
  }
  const { data } = await service
    .from("bulk_email_campaigns")
    .select("id, subject, body_html, kind, status, recipient_count, sent_count, failed_count, created_at, sent_at")
    .order("created_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ campaigns: data || [] });
}
