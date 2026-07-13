import { createServiceSupabase } from "@/lib/supabase";
import { lookupVendor } from "@/lib/vendor-knowledge";
import { normalizeAccountName } from "@/lib/account-name";

/**
 * Fleet vendor remediation — scan layer.
 * ──────────────────────────────────────
 * After the 2026-07 vendor-KB rebuild (PR #69: Mike/Lisa reviewed every rule),
 * transactions we EXECUTED under the old rules may sit in accounts the
 * reviewed KB now maps differently (Sobeys in Employee Benefits, EZ Pass in
 * Permit Fees, …). This module finds those rows.
 *
 * A row is a remediation candidate when ALL hold:
 *   - status = 'executed'                 → WE posted it (not a human pick)
 *   - new KB match confidence ≥ 0.95      → the established auto-execute floor
 *   - KB target ≠ the account we posted   → i.e. the old rules got it wrong
 *   - |amount| < $500                     → wizard auto-approve threshold
 *   - KB target ≠ current from_account    → sanity (no no-op moves)
 *
 * The scan is DB-only (read-only, no QBO calls). Two later gates run at APPLY
 * time, per client: the QBO closing-date check (never touch closed periods)
 * and the stale guard in reclassifyTransactionLines (refetch each txn; skip
 * any line whose CURRENT account no longer matches what we posted — that
 * means a human moved it after us, and their decision wins).
 */

export interface RemediationCandidate {
  reclassification_id: string;
  client_link_id: string;
  client_name: string;
  qbo_transaction_id: string;
  qbo_transaction_type: string;
  line_id: string;
  transaction_date: string | null;
  transaction_amount: number | null;
  vendor_name: string | null;
  description: string | null;
  /** account the row is in NOW (what we set at execute) */
  current_account: string;
  /** where the reviewed KB says it belongs */
  target_account: string;
  /** canonical payee from the KB (stamped on push when txn has none) */
  target_vendor: string | null;
  kb_confidence: number;
  kb_reasoning: string;
}

export const REMEDIATION_MAX_AMOUNT = 500;
// 0.90, not 0.95: the 82 Mike/Lisa-reviewed fleet vendors were loaded at 0.9
// and the grocery recats at 0.92 — a 0.95 floor silently excluded ALL of them
// (first scan showed 751 candidates/38 clients; at 0.90 it's 3,340/60, the
// full reviewed rule set). Everything ≥0.90 is either human-reviewed or a
// long-standing exact-brand rule; below 0.90 are the deliberately-uncertain
// rules (bare Google/Facebook, "likely" mappings) that queue for humans.
export const REMEDIATION_MIN_CONFIDENCE = 0.90;

const norm = (s: string | null | undefined) => normalizeAccountName(s || "");

/** Leaf-tolerant account equality: "Parent:Child" matches "Child". */
export function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const la = na.split(":").pop() || na;
  const lb = nb.split(":").pop() || nb;
  return la === lb;
}

/**
 * Scan the whole fleet's executed reclassification rows against the current
 * KB. Read-only. Returns candidates grouped by nothing — callers group for
 * display. `clientLinkIds` limits the scan (used by apply-time revalidation).
 */
export async function scanForCandidates(opts?: {
  clientLinkIds?: string[];
  reclassificationIds?: string[];
}): Promise<RemediationCandidate[]> {
  const service = createServiceSupabase();

  // client_link_id lives on the job — build job → client map first.
  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id, client_link_id");
  const jobClient = new Map<string, string>();
  for (const j of jobs || []) {
    if (j.id && j.client_link_id) jobClient.set(j.id, j.client_link_id);
  }

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, industry, is_active")
    .eq("is_active", true);
  const clientById = new Map<string, { name: string; industry: string }>();
  for (const c of clients || []) {
    clientById.set(c.id, { name: c.client_name, industry: (c as any).industry || "painters" });
  }

  const candidates: RemediationCandidate[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    let q = service
      .from("reclassifications")
      .select(
        "id, reclass_job_id, qbo_transaction_id, qbo_transaction_type, line_id, transaction_date, transaction_amount, vendor_name, description, to_account_name, from_account_name, status"
      )
      .eq("status", "executed")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (opts?.reclassificationIds?.length) q = q.in("id", opts.reclassificationIds);
    const { data: rows, error } = await q;
    if (error) throw new Error(`scan page failed: ${error.message}`);
    if (!rows?.length) break;

    for (const r of rows) {
      const clientId = r.reclass_job_id ? jobClient.get(r.reclass_job_id) : null;
      if (!clientId) continue;
      const client = clientById.get(clientId);
      if (!client) continue; // inactive client
      if (opts?.clientLinkIds?.length && !opts.clientLinkIds.includes(clientId)) continue;
      if (!r.line_id || !r.qbo_transaction_id) continue;

      const amount = r.transaction_amount ?? 0;
      if (Math.abs(amount) >= REMEDIATION_MAX_AMOUNT) continue;

      const kb = lookupVendor(r.vendor_name || "", r.description || "", amount, client.industry);
      if (!kb || kb.confidence < REMEDIATION_MIN_CONFIDENCE) continue;

      const current = r.to_account_name || "";
      if (!current) continue;
      if (sameAccount(kb.account, current)) continue;          // already right
      if (sameAccount(kb.account, r.from_account_name)) continue; // would undo our own move — leave for review

      candidates.push({
        reclassification_id: r.id,
        client_link_id: clientId,
        client_name: client.name,
        qbo_transaction_id: r.qbo_transaction_id,
        qbo_transaction_type: r.qbo_transaction_type || "Purchase",
        line_id: r.line_id,
        transaction_date: r.transaction_date,
        transaction_amount: amount,
        vendor_name: r.vendor_name,
        description: r.description,
        current_account: current,
        target_account: kb.account,
        target_vendor: kb.vendor || null,
        kb_confidence: kb.confidence,
        kb_reasoning: kb.reasoning,
      });
    }

    if (rows.length < PAGE) break;
    from += PAGE;
  }

  return candidates;
}
