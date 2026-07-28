import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { priorPeriodMonth } from "@/lib/client-months";

export const dynamic = "force-dynamic";

/**
 * GET /api/client-months?client=<id>[&month=YYYY-MM]
 *
 * The month row for one client, so the client workspace can render the
 * monthly-close sequence with real progress. Defaults to the PRIOR month —
 * that's the one you're closing.
 *
 * Get-or-create: a client who has never been closed has no row, and the
 * sequence has to render (and be markable) from the first click. The PATCH
 * sibling needs a row id to write to.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const clientLinkId = (url.searchParams.get("client") || "").trim();
  const monthParam = (url.searchParams.get("month") || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client required" }, { status: 400 });
  const periodMonth = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : priorPeriodMonth(new Date());

  const { data: existing, error } = await (service as any)
    .from("client_months")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .eq("period_month", periodMonth)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (existing) return NextResponse.json({ month: existing, period_month: periodMonth });

  const { data: created, error: insErr } = await (service as any)
    .from("client_months")
    .insert({ client_link_id: clientLinkId, period_month: periodMonth })
    .select("*")
    .single();
  if (insErr) {
    // Lost a race with a concurrent create — re-read rather than fail.
    const { data: raced } = await (service as any)
      .from("client_months")
      .select("*")
      .eq("client_link_id", clientLinkId)
      .eq("period_month", periodMonth)
      .maybeSingle();
    if (raced) return NextResponse.json({ month: raced, period_month: periodMonth });
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }
  return NextResponse.json({ month: created, period_month: periodMonth });
}
