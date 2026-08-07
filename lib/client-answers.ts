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
  /** Normalized vendor pattern — the grouping key bank rules are keyed on. */
  vendor_pattern: string | null;
  description: string | null;
  from_account: string | null;
  /** The account the client picked in their portal (null = free-text only). */
  answer_account: string | null;
  answer_note: string | null;
  answered_at: string;
  /** Last apply error, if a previous attempt failed OR was blocked. */
  error: string | null;
  /**
   * QBO refused the write for a reason the bookkeeper must clear by hand —
   * the transaction is matched to a bank-feed download, or it's in a closed
   * period. Approving again changes nothing until they do.
   */
  blocked: boolean;
}

/** The apply route writes these with a "Blocked — " prefix. */
export function isBlockedMessage(msg: string | null | undefined): boolean {
  return /^blocked\s*[—-]/i.test((msg || "").trim());
}

export async function getClientAnswers(
  service: SupabaseClient,
  opts?: { scopeUserId?: string | null }
): Promise<ClientAnswerRow[]> {
  const svc = service as any;
  const { data, error } = await svc
    .from("reclassifications")
    .select(
      `id, reclass_job_id, transaction_date, transaction_amount, vendor_name, vendor_pattern_normalized, description,
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
      vendor_pattern: r.vendor_pattern_normalized || null,
      description: r.description || null,
      from_account: r.from_account_name || null,
      answer_account: r.client_response_account || null,
      answer_note: r.client_response_note || null,
      answered_at: r.client_responded_at,
      // Was `status === "failed" ? ... : null`, which silently dropped every
      // BLOCKED row: the apply route deliberately does NOT mark a blocked row
      // failed (it stays approvable once the bookkeeper unmatches it in QBO),
      // so those rows kept status 'pending' and their reason never reached the
      // UI. Measured 2026-08-07: 19 of 21 blocked rows were displaying as
      // completely ordinary — approve, nothing happens, no explanation.
      error: r.error_message || (r.status === "failed" ? "Previous apply failed" : null),
      blocked: isBlockedMessage(r.error_message),
    });
  }
  return rows;
}
