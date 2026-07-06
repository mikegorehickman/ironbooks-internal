import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Client answers queue — ask-client reclass rows the client has ANSWERED
 * (from /portal/categorize) that no bookkeeper has confirmed yet. The
 * bookkeeper's default action is one-click Approve (apply the client's
 * pick to QBO); the alternative is an AI-suggested similar account.
 */

export interface ClientAnswerRow {
  id: string;
  reclass_job_id: string;
  client_link_id: string;
  client_name: string;
  date: string | null;
  amount: number;
  vendor: string | null;
  description: string | null;
  from_account: string | null;
  /** The account the client picked in their portal (null = free-text only). */
  answer_account: string | null;
  answer_note: string | null;
  answered_at: string;
  /** Last apply error, if a previous attempt failed. */
  error: string | null;
}

export async function getClientAnswers(
  service: SupabaseClient,
  opts?: { scopeUserId?: string | null }
): Promise<ClientAnswerRow[]> {
  const svc = service as any;
  const { data, error } = await svc
    .from("reclassifications")
    .select(
      `id, reclass_job_id, transaction_date, transaction_amount, vendor_name, description,
       from_account_name, client_response_account, client_response_note, client_responded_at,
       status, error_message,
       reclass_jobs!reclass_job_id!inner(id, client_link_id,
         client_links(id, client_name, is_active, assigned_bookkeeper_id))`
    )
    .eq("decision", "ask_client")
    .not("client_responded_at", "is", null)
    .neq("status", "executed")
    .order("client_responded_at", { ascending: false })
    .limit(300);
  if (error) throw error;

  const rows: ClientAnswerRow[] = [];
  for (const r of (data as any[]) || []) {
    const job = r.reclass_jobs;
    const client = job?.client_links;
    if (!client || client.is_active === false) continue;
    if (opts?.scopeUserId && client.assigned_bookkeeper_id !== opts.scopeUserId) continue;
    rows.push({
      id: r.id,
      reclass_job_id: job.id,
      client_link_id: client.id,
      client_name: client.client_name,
      date: r.transaction_date,
      amount: Number(r.transaction_amount || 0),
      vendor: r.vendor_name && r.vendor_name !== "Unknown vendor" ? r.vendor_name : null,
      description: r.description || null,
      from_account: r.from_account_name || null,
      answer_account: r.client_response_account || null,
      answer_note: r.client_response_note || null,
      answered_at: r.client_responded_at,
      error: r.status === "failed" ? r.error_message || "Previous apply failed" : null,
    });
  }
  return rows;
}
