import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/categorize
 *
 * Client answers for ask-client reclass rows. NO QBO writes — answers
 * land on the reclassification rows (client_response_*) and one
 * from_client message summarizes the whole batch for the bookkeeper's
 * /today queue + Messages thread.
 *
 * Body: { answers: [{ id, account: string|null, note: string|null }] }
 *       account=null means "Other" — note required in that case.
 */
export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const answers: Array<{ id?: string; account?: string | null; note?: string | null }> =
    Array.isArray(body.answers) ? body.answers : [];
  if (answers.length === 0 || answers.length > 200) {
    return NextResponse.json({ error: "1–200 answers required" }, { status: 400 });
  }

  const clean = answers
    .map((a) => ({
      id: String(a.id || "").trim(),
      account: a.account ? String(a.account).slice(0, 300) : null,
      note: a.note ? String(a.note).slice(0, 500) : null,
    }))
    .filter((a) => a.id && (a.account || a.note));
  if (clean.length === 0) {
    return NextResponse.json({ error: "No valid answers" }, { status: 400 });
  }

  const service = createServiceSupabase() as any;

  // Ownership check: every row must belong to a reclass job of THIS
  // client. Row ids from the request are never trusted on their own.
  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id")
    .eq("client_link_id", ctx.clientLinkId);
  const jobIds = new Set(((jobs as any[]) || []).map((j) => j.id));

  const { data: rows } = await service
    .from("reclassifications")
    .select("id, reclass_job_id, transaction_date, transaction_amount, vendor_name, description, decision")
    .in("id", clean.map((a) => a.id));
  const rowById = new Map(((rows as any[]) || []).map((r) => [r.id, r]));

  const accepted: Array<{ row: any; account: string | null; note: string | null }> = [];
  for (const a of clean) {
    const row = rowById.get(a.id);
    if (!row || !jobIds.has(row.reclass_job_id) || row.decision !== "ask_client") continue;
    accepted.push({ row, account: a.account, note: a.note });
  }
  if (accepted.length === 0) {
    return NextResponse.json({ error: "No matching transactions" }, { status: 404 });
  }

  const respondedAt = new Date().toISOString();
  for (const a of accepted) {
    await service
      .from("reclassifications")
      .update({
        client_response_account: a.account || "Other (see note)",
        client_response_note: a.note,
        client_responded_at: respondedAt,
      })
      .eq("id", a.row.id);
  }

  // ONE summary message back to the bookkeeper — rides the existing
  // from_client machinery (/today widget, sidebar badge, chime).
  const lines = accepted.map((a, i) => {
    const d = a.row.transaction_date ? String(a.row.transaction_date).slice(0, 10) : "—";
    const amount = `$${Math.abs(Number(a.row.transaction_amount) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const what = a.row.vendor_name && a.row.vendor_name !== "Unknown vendor" ? a.row.vendor_name : a.row.description || "Unlabeled";
    const pick = a.account || "Other (see note)";
    return `${i + 1}. ${d} — ${amount} — ${what} → ${pick}${a.note ? ` ("${a.note}")` : ""}`;
  });
  const n = accepted.length;
  await service.from("client_communications").insert({
    client_link_id: ctx.clientLinkId,
    sender_user_id: ctx.userId,
    direction: "from_client",
    kind: "message",
    subject: `Categorized ${n} transaction${n === 1 ? "" : "s"}`,
    body: [
      `I answered ${n} transaction question${n === 1 ? "" : "s"} on the Categorize page:`,
      ``,
      ...lines.slice(0, 100),
      ...(lines.length > 100 ? [`…plus ${lines.length - 100} more — see the reclass review screen.`] : []),
    ].join("\n").slice(0, 8000),
  });

  await service.from("audit_log").insert({
    event_type: "portal_categorize_answers",
    user_id: ctx.userId,
    request_payload: {
      client_link_id: ctx.clientLinkId,
      answered: n,
      row_ids: accepted.map((a) => a.row.id).slice(0, 200),
    },
  });

  return NextResponse.json({ ok: true, answered: n });
}
