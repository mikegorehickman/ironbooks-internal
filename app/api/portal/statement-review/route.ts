import { NextResponse } from "next/server";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";

/**
 * POST /api/portal/statement-review
 *
 * Client responds to a DRAFT statement month from the portal gut-check
 * panel (Mike, 2026-07-15): approve ("looks right"), or add missing info.
 * Questions go through the existing portal messages flow — this route only
 * records the structured review.
 *
 * Body:
 *   {
 *     period_year: number,
 *     period_month: number,
 *     status: "approved" | "info_added",
 *     answers?: { revenue_complete?: boolean|null, accounts_complete?: boolean|null,
 *                 cash_payments?: boolean|null, tax_ok?: boolean|null },
 *     note?: string
 *   }
 *
 * One row per client+period, upserted — a client can add info first and
 * approve later; approve never downgrades to info_added. An approval is the
 * signal a senior uses to graduate the client DRAFT → VERIFIED (one-click on
 * /today) — the stage itself is never flipped from the portal.
 */
export const dynamic = "force-dynamic";

const MAX_NOTE_LEN = 2000;
const ANSWER_KEYS = ["revenue_complete", "accounts_complete", "cash_payments", "tax_ok"] as const;

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  // Impersonating admins must not leave attestations in the client's name.
  if (ctx.impersonating) {
    return NextResponse.json(
      { error: "You're viewing as an admin (impersonating). Draft reviews are disabled in this mode.", code: "impersonating" },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const periodYear = Number(body.period_year);
  const periodMonth = Number(body.period_month);
  const status = String(body.status || "");
  if (!periodYear || !periodMonth || periodMonth < 1 || periodMonth > 12) {
    return NextResponse.json({ error: "period_year and period_month are required" }, { status: 400 });
  }
  if (!["approved", "info_added"].includes(status)) {
    return NextResponse.json({ error: "status must be 'approved' or 'info_added'" }, { status: 400 });
  }

  const answers: Record<string, boolean | null> = {};
  for (const k of ANSWER_KEYS) {
    const v = body.answers?.[k];
    if (typeof v === "boolean" || v === null) answers[k] = v;
  }
  const note = String(body.note || "").trim().slice(0, MAX_NOTE_LEN) || null;

  const service = createServiceSupabase();
  const now = new Date().toISOString();

  // Approve wins over a prior info_added; a later info_added never
  // downgrades an approval (the client already attested).
  const { data: existingRow } = await service
    .from("statement_reviews" as any)
    .select("id, status, answers, note")
    .eq("client_link_id", ctx.clientLinkId)
    .eq("period_year", periodYear)
    .eq("period_month", periodMonth)
    .maybeSingle();
  const existing = existingRow as { id: string; status: string; answers: Record<string, boolean | null> | null; note: string | null } | null;

  const mergedStatus = existing?.status === "approved" ? "approved" : status;
  const mergedAnswers = { ...(existing?.answers || {}), ...answers };
  const mergedNote = note && existing?.note ? `${existing.note}\n---\n${note}` : note || existing?.note || null;

  const { error } = await service.from("statement_reviews" as any).upsert(
    {
      client_link_id: ctx.clientLinkId,
      period_year: periodYear,
      period_month: periodMonth,
      status: mergedStatus,
      answers: mergedAnswers,
      note: mergedNote,
      portal_email: ctx.userEmail || null,
      updated_at: now,
    } as any,
    { onConflict: "client_link_id,period_year,period_month" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service.from("audit_log").insert({
    event_type: "statement_draft_review",
    request_payload: {
      client_link_id: ctx.clientLinkId,
      period: `${periodYear}-${String(periodMonth).padStart(2, "0")}`,
      status: mergedStatus,
      answers: mergedAnswers,
      has_note: !!note,
      portal_email: ctx.userEmail || null,
    } as any,
  } as any);

  return NextResponse.json({ ok: true, status: mergedStatus });
}
