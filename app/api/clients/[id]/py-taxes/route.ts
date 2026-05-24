import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/clients/[id]/py-taxes
 *
 * One-time client setting: whether prior-year taxes are filed, and through
 * which year. Set on onboarding, edited from the client card.
 *
 * Body: { py_taxes_filed: boolean, py_taxes_filed_through_year?: number | null }
 *
 * Used downstream by the new-reclass form to default date ranges to "current
 * year only" so we don't touch already-filed books.
 *
 * Owner bookkeeper or admin/lead only.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: client } = await service
    .from("client_links")
    .select("id, assigned_bookkeeper_id")
    .eq("id", id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const update: Record<string, any> = {
    py_taxes_updated_at: new Date().toISOString(),
    py_taxes_updated_by: user.id,
  };

  if (typeof body.py_taxes_filed === "boolean") {
    update.py_taxes_filed = body.py_taxes_filed;
    // If unsetting, also clear the year.
    if (!body.py_taxes_filed) update.py_taxes_filed_through_year = null;
  }

  if (body.py_taxes_filed_through_year !== undefined) {
    const yr = body.py_taxes_filed_through_year;
    if (yr === null) {
      update.py_taxes_filed_through_year = null;
    } else {
      const yearInt = parseInt(String(yr), 10);
      // Sanity bounds — somewhere between 2000 and 5 years past current year.
      const thisYear = new Date().getFullYear();
      if (!Number.isFinite(yearInt) || yearInt < 2000 || yearInt > thisYear + 5) {
        return NextResponse.json(
          { error: `Invalid year ${yr} — expected 2000–${thisYear + 5}` },
          { status: 400 }
        );
      }
      update.py_taxes_filed_through_year = yearInt;
    }
  }

  // Data-integrity guard: filed=true requires a year (and conversely
  // filed=false forces year=null, which we already do above). Catches
  // direct-PATCH callers with partial bodies — the widget always sends
  // both fields together so this shouldn't fire from normal use.
  if (update.py_taxes_filed === true && update.py_taxes_filed_through_year == null) {
    return NextResponse.json(
      { error: "py_taxes_filed=true requires py_taxes_filed_through_year (year)" },
      { status: 400 }
    );
  }

  // Bail out if there's nothing to actually change (body had no
  // recognized fields). Avoids a no-op write that bumps updated_at.
  const hasFieldUpdate =
    "py_taxes_filed" in update || "py_taxes_filed_through_year" in update;
  if (!hasFieldUpdate) {
    return NextResponse.json(
      { error: "No recognized fields in body (expected py_taxes_filed and/or py_taxes_filed_through_year)" },
      { status: 400 }
    );
  }

  const { error } = await service
    .from("client_links")
    .update(update as any)
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "py_taxes_update",
    request_payload: {
      client_link_id: id,
      py_taxes_filed: update.py_taxes_filed,
      py_taxes_filed_through_year: update.py_taxes_filed_through_year,
    } as any,
  });

  return NextResponse.json({ ok: true, updated: update });
}
