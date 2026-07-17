import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/email-log/[logId]
 *
 * The "sync from Resend" — pulls the ACTUAL sent email back from Resend by
 * its stored message id (GET /emails/{id}): the rendered HTML the client
 * received, the recipients, and the live last_event (delivered / opened /
 * bounced). Lets the bookkeeper see exactly what went out and whether it
 * landed, straight from Resend. Read-only; staff roles.
 *
 * RESEND_API_KEY lives in Vercel only, so this works in the deployed app.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; logId: string }> }
) {
  const { id, logId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper", "viewer"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: row } = await (service as any)
    .from("client_email_log")
    .select("id, client_link_id, subject, to_address, status, provider_message_id, created_at, delivered_at, opened_at, email_type")
    .eq("id", logId)
    .eq("client_link_id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Email log entry not found" }, { status: 404 });

  const messageId = (row as any).provider_message_id as string | null;
  // Our stored record — always returned so the panel has something to show
  // even if Resend can't be reached.
  const stored = {
    id: row.id,
    subject: row.subject,
    to_address: row.to_address,
    status: row.status,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    opened_at: row.opened_at,
  };

  if (!messageId) {
    return NextResponse.json({ stored, resend: null, resend_error: "No Resend message id on this send (older or untracked)." });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ stored, resend: null, resend_error: "RESEND_API_KEY not configured on this environment." });
  }

  try {
    const res = await fetch(`https://api.resend.com/emails/${messageId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return NextResponse.json({ stored, resend: null, resend_error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` });
    }
    const e = await res.json();
    return NextResponse.json({
      stored,
      resend: {
        subject: e?.subject ?? null,
        to: e?.to ?? null,
        from: e?.from ?? null,
        html: e?.html ?? null,
        text: e?.text ?? null,
        created_at: e?.created_at ?? null,
        // Resend returns last_event on the email object ("delivered", "opened", …)
        last_event: e?.last_event ?? null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ stored, resend: null, resend_error: err?.message || "Resend fetch failed" });
  }
}
