import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { sendStatementRequestEmail } from "@/lib/statement-request-email";

/**
 * POST /api/clients/[id]/request-statements-email
 *   { labels: string[], client_name?: string, override_email?: string }
 *
 * Emails the client the branded "please upload these statements" request and
 * logs it. The statement_requests rows are created separately via
 * POST /api/clients/[id]/statement-requests. 200 + { no_address:true } when
 * there's no address on file (prompt the bookkeeper to enter one).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const labels: string[] = Array.isArray(body.labels)
    ? body.labels.filter((l: any) => typeof l === "string" && l.trim()).map((l: string) => l.trim())
    : [];
  if (labels.length === 0) {
    return NextResponse.json({ error: "At least one statement label is required." }, { status: 400 });
  }

  const service = createServiceSupabase();
  let clientName: string = body.client_name || "";
  if (!clientName) {
    const { data: cl } = await service.from("client_links").select("client_name").eq("id", clientLinkId).single();
    clientName = (cl as any)?.client_name || "your business";
  }

  const result = await sendStatementRequestEmail(service, {
    clientLinkId,
    clientName,
    labels,
    createdByUserId: user.id,
    overrideEmail: body.override_email ?? null,
  });

  if (!result.ok && !result.noAddress) {
    return NextResponse.json({ error: result.error || "Could not send", ...result }, { status: 500 });
  }
  return NextResponse.json({
    sent: result.sent,
    recipients: result.recipients,
    addresses: result.addresses,
    no_address: result.noAddress,
    error: result.error,
  });
}
