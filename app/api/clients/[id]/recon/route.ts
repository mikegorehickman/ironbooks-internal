import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { accountKindOf, createReconSession } from "@/lib/recon-sessions";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // session creation reads the statement PDF with Claude

const STAFF = ["admin", "lead", "bookkeeper"];

async function gate(clientLinkId: string) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { fail: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!STAFF.includes((actor as any)?.role || "")) {
    return { fail: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return { fail: NextResponse.json({ error: "Client not found" }, { status: 404 }) };
  return { user, service, client };
}

/**
 * GET /api/clients/[id]/recon — the reconcile picker payload: bank/CC/loan
 * accounts, processed statements (with extracted balance + end date), and
 * this client's sessions.
 */
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate(id);
  if ("fail" in g) return g.fail;
  const { service, client } = g;

  let accounts: Array<{ id: string; name: string; kind: string; balance: number }> = [];
  try {
    const token = await getValidToken(client.id, service, "recon-picker");
    const all = await fetchAllAccounts((client as any).qbo_realm_id, token);
    accounts = all
      .filter((a) => a.Active !== false)
      .filter((a) => {
        const t = (a.AccountType || "").toLowerCase();
        return t === "bank" || t === "credit card";
      })
      .map((a) => ({ id: String(a.Id), name: a.Name, kind: accountKindOf(a), balance: a.CurrentBalance ?? 0 }));
  } catch {
    accounts = [];
  }

  const { data: statements } = await (service as any)
    .from("client_statements")
    .select("id, display_name, matched_qbo_account_id, matched_account_name, ending_balance, statement_end_date, account_kind, reconciled_session_id")
    .eq("client_link_id", id)
    .not("ending_balance", "is", null)
    .order("statement_end_date", { ascending: false })
    .limit(60);

  const { data: sessions } = await (service as any)
    .from("recon_sessions")
    .select("id, qbo_account_id, qbo_account_name, account_kind, ending_balance, statement_end_date, status, difference, cleared_count, finished_at, created_at")
    .eq("client_link_id", id)
    .order("created_at", { ascending: false })
    .limit(40);

  return NextResponse.json({
    client_name: (client as any).client_name,
    accounts,
    statements: statements || [],
    sessions: sessions || [],
  });
}

/**
 * POST /api/clients/[id]/recon — create a session.
 * Body: { account_id, statement_id? } or { account_id, ending_balance, statement_end_date, statement_start_date? }
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate(id);
  if ("fail" in g) return g.fail;
  const { user, service, client } = g;

  const body = await request.json().catch(() => ({}));
  if (!body.account_id) return NextResponse.json({ error: "account_id required" }, { status: 400 });

  const result = await createReconSession(
    service,
    client as any,
    {
      account_id: String(body.account_id),
      statement_id: body.statement_id || null,
      ending_balance: body.ending_balance != null ? Number(body.ending_balance) : null,
      statement_end_date: body.statement_end_date || null,
      statement_start_date: body.statement_start_date || null,
    },
    user.id
  );
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ session_id: result.id });
}
