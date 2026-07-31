import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { queryAuditLog } from "@/lib/audit-query";
import { NextResponse } from "next/server";

/**
 * GET /api/admin/audit
 *
 * Searchable audit log. Filters: user_id, client_link_id, job_id, event_type,
 * since, until. Returns the 200 most recent matches by default (max 2,000), and
 * says so in `notes` when the cap bites — an unreported cap reads as complete.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow admin OR lead to view audit log (Lisa needs to review work too)
  const { data: actor } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!actor || !["admin", "lead"].includes(actor.role)) {
    return NextResponse.json({ error: "Admin or Lead only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("user_id");
  const clientLinkId = searchParams.get("client_link_id");
  const jobId = searchParams.get("job_id");
  const eventType = searchParams.get("event_type");
  const since = searchParams.get("since");
  const until = searchParams.get("until");
  const limit = parseInt(searchParams.get("limit") || "200");

  // Reads audit_log directly via lib/audit-query. The previous implementation
  // read `recent_activity_feed`, a 500-row view — so every filter here searched
  // only the last ~29 hours of a 23,211-row log, and a client filter matched
  // nothing at all because that view resolves the client only through job_id.
  const { rows, notes, hasClientColumn } = await queryAuditLog(createServiceSupabase(), {
    userId,
    clientLinkId,
    jobId,
    eventType,
    since,
    until,
    limit,
  });

  return NextResponse.json({
    events: rows,
    count: rows.length,
    notes,
    client_attribution_complete: hasClientColumn,
  });
}
