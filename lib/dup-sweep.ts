import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPLDetailAll } from "./qbo-reports";
import { findDuplicates, type DupFinding } from "./qbo-dup-scan";
import { getValidToken, getCompanyClosingDate } from "./qbo-reclass";
import { qboRequest } from "./qbo";

/**
 * Duplicate sweep — the shared engine behind:
 *   - the Duplicates stage on reclass review (cleanup phase)
 *   - the weekly production sweep (cron) + one-time admin clean sweep
 *   - the /today Duplicates queue
 *
 * Detection is lib/qbo-dup-scan's findDuplicates (same-day twins, doc-number
 * dupes, near-dupes). This module adds the TIER classification and the
 * persistence: each duplicate GROUP is upserted into dup_findings keyed by
 * (client, fingerprint), so re-scans refresh rather than re-raise, and
 * resolved/kept findings never come back.
 *
 * Tier "certain" — the only class where duplication is PROVABLE — requires:
 *   exactly 2 txns · same type · one bank-fed, one manually entered ·
 *   the manual twin unreconciled · dated after the QBO closing date ·
 *   no linked transactions. The bank feed is ground truth (the bank moved
 *   the money once), so the MANUAL twin is the duplicate. Everything else
 *   is at best "likely" and requires a human click.
 */

const MIN_AMOUNT = 25; // ignore sub-$25 noise
const WINDOW_DAYS = 90;
const CERTAIN_ENRICH_CAP = 10; // per-client per-scan QBO reads budget

/** Void where QBO supports it (audit-friendly), hard delete otherwise. */
const VOIDABLE = new Set(["Invoice", "Payment", "SalesReceipt", "Check"]);
const RESOURCE: Record<string, string> = {
  Invoice: "invoice", Payment: "payment", SalesReceipt: "salesreceipt",
  Check: "purchase", Expense: "purchase", "Cash Expense": "purchase",
  "Credit Card Expense": "purchase", Purchase: "purchase",
  Deposit: "deposit", Bill: "bill", "Journal Entry": "journalentry",
  JournalEntry: "journalentry",
};
const ENTITY: Record<string, string> = {
  Check: "Purchase", Expense: "Purchase", "Cash Expense": "Purchase",
  "Credit Card Expense": "Purchase", "Journal Entry": "JournalEntry",
};

export function qboEntityFor(txnType: string): { entity: string; resource: string } | null {
  const resource = RESOURCE[txnType];
  if (!resource) return null;
  return { entity: ENTITY[txnType] || txnType, resource };
}

async function fetchFullTxn(realmId: string, token: string, txnType: string, txnId: string) {
  const map = qboEntityFor(txnType);
  if (!map) return null;
  const q = encodeURIComponent(`SELECT * FROM ${map.entity} WHERE Id = '${txnId}'`);
  const data: any = await qboRequest(realmId, token, `/query?query=${q}`, { method: "GET" });
  return data?.QueryResponse?.[map.entity]?.[0] || null;
}

function isBankFedTxn(t: any): boolean {
  // Same heuristic the reclass pull uses: bank-feed matched txns carry the
  // OLB (online banking) marker; hand-keyed ones don't.
  const src = String(t?.TxnSource || "");
  return /olb|bank/i.test(src);
}

function anyLineReconciled(t: any): boolean {
  return (t?.Line || []).some((l: any) => l?.Cleared === "Reconciled" || l?.LineEx?.Cleared === "Reconciled");
}

function hasLinks(t: any): boolean {
  if ((t?.LinkedTxn || []).length > 0) return true;
  return (t?.Line || []).some((l: any) => (l?.LinkedTxn || []).length > 0);
}

/**
 * Try to prove one of the two txns in a group is a removable manual twin.
 * Returns the remove candidate or null (→ stays "likely").
 */
async function qualifyCertain(
  realmId: string,
  token: string,
  f: DupFinding,
  closingDate: string | null
): Promise<{ txn_id: string; txn_type: string; reason: string } | null> {
  if (f.kind === "near_duplicate") return null;
  if (f.txn_ids.length !== 2) return null;
  const types = [...new Set(f.txn_types)];
  if (types.length !== 1) return null;

  const [a, b] = await Promise.all([
    fetchFullTxn(realmId, token, f.txn_types[0], f.txn_ids[0]).catch(() => null),
    fetchFullTxn(realmId, token, f.txn_types[1] || f.txn_types[0], f.txn_ids[1]).catch(() => null),
  ]);
  if (!a || !b) return null;

  const aFed = isBankFedTxn(a);
  const bFed = isBankFedTxn(b);
  if (aFed === bFed) return null; // need exactly one bank-fed, one manual

  const manual = aFed ? b : a;
  const manualId = String(manual.Id);
  const manualType = f.txn_types[f.txn_ids.indexOf(manualId)] || f.txn_types[0];

  if (anyLineReconciled(manual)) return null;
  if (hasLinks(manual)) return null;
  if (closingDate && manual.TxnDate && manual.TxnDate <= closingDate) return null;

  return {
    txn_id: manualId,
    txn_type: manualType,
    reason: "Bank-fed twin exists — this copy was hand-entered, is unreconciled, unlinked, and in an open period",
  };
}

export interface SweepResult {
  scanned: boolean;
  found: number;
  certain: number;
  likely: number;
  possible: number;
  error?: string;
}

/** Scan one client and upsert findings. Read-only against QBO. */
export async function scanClientForDuplicates(
  service: SupabaseClient,
  clientLink: { id: string; qbo_realm_id: string },
  opts?: { windowDays?: number; minAmount?: number }
): Promise<SweepResult> {
  const svc = service as any;
  const windowDays = opts?.windowDays ?? WINDOW_DAYS;
  const minAmount = opts?.minAmount ?? MIN_AMOUNT;

  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);

  const token = await getValidToken(clientLink.id, svc);
  const rows = await fetchPLDetailAll(clientLink.qbo_realm_id, token, start, end, "Cash");
  const findings = findDuplicates(rows, minAmount);

  let closingDate: string | null = null;
  try {
    closingDate = await getCompanyClosingDate(clientLink.qbo_realm_id, token);
  } catch {}

  const counts = { certain: 0, likely: 0, possible: 0 };
  let enriched = 0;

  for (const f of findings) {
    const fingerprint = `${f.kind}:${[...f.txn_ids].sort().join(",")}`;

    // Never resurrect a finding a human already resolved or kept.
    const { data: existing } = await svc
      .from("dup_findings")
      .select("id, status")
      .eq("client_link_id", clientLink.id)
      .eq("fingerprint", fingerprint)
      .maybeSingle();
    if (existing && existing.status !== "open") continue;

    let tier: "certain" | "likely" | "possible" =
      f.severity === "high" ? "likely" : "possible";
    let removeCandidate: { txn_id: string; txn_type: string; reason: string } | null = null;

    if (f.severity === "high" && enriched < CERTAIN_ENRICH_CAP) {
      enriched++;
      removeCandidate = await qualifyCertain(clientLink.qbo_realm_id, token, f, closingDate);
      if (removeCandidate) tier = "certain";
    }
    counts[tier]++;

    const payload = {
      client_link_id: clientLink.id,
      fingerprint,
      kind: f.kind,
      tier,
      section: f.section,
      account: f.account,
      name: f.name,
      amount: f.amount,
      dates: f.dates,
      txn_types: f.txn_types,
      txn_ids: f.txn_ids,
      doc_numbers: f.doc_numbers,
      note: f.note,
      remove_candidate: removeCandidate,
      last_seen_at: new Date().toISOString(),
    };
    if (existing) {
      await svc.from("dup_findings").update(payload).eq("id", existing.id);
    } else {
      await svc.from("dup_findings").insert(payload);
    }
  }

  return {
    scanned: true,
    found: findings.length,
    certain: counts.certain,
    likely: counts.likely,
    possible: counts.possible,
  };
}

/**
 * Remove one transaction of a duplicate group: snapshot → void (or delete
 * where QBO can't void) → mark the finding resolved. Re-checks every safety
 * guard against the LIVE transaction at click time.
 */
export async function removeDuplicateTxn(
  service: SupabaseClient,
  finding: any,
  txnId: string,
  userId: string
): Promise<{ ok: true; method: string } | { ok: false; error: string }> {
  const svc = service as any;
  const { data: clientLink } = await svc
    .from("client_links")
    .select("id, qbo_realm_id, client_name")
    .eq("id", finding.client_link_id)
    .single();
  if (!clientLink) return { ok: false, error: "Client not found" };

  if (!(finding.txn_ids as string[]).includes(txnId)) {
    return { ok: false, error: "Transaction isn't part of this finding" };
  }
  // txn_types is a deduped SET (not aligned with txn_ids) — resolve the type
  // by trying each candidate until QBO returns the transaction.
  const typeCandidates: string[] =
    finding.remove_candidate?.txn_id === txnId && finding.remove_candidate?.txn_type
      ? [finding.remove_candidate.txn_type]
      : [...new Set(finding.txn_types as string[])];

  const token = await getValidToken(clientLink.id, svc);
  let live: any = null;
  let txnType = typeCandidates[0];
  for (const t of typeCandidates) {
    if (!qboEntityFor(t)) continue;
    live = await fetchFullTxn(clientLink.qbo_realm_id, token, t, txnId).catch(() => null);
    if (live) {
      txnType = t;
      break;
    }
  }
  const map = qboEntityFor(txnType);
  if (!map) return { ok: false, error: `Unsupported transaction type "${txnType}"` };
  if (!live) return { ok: false, error: "Transaction no longer exists in QuickBooks" };

  // Live-guards at click time — the scan may be days old.
  if (anyLineReconciled(live)) {
    return { ok: false, error: "This copy is reconciled — remove the other one, or handle in QBO" };
  }
  if (hasLinks(live)) {
    return { ok: false, error: "This transaction has linked transactions (payments/applications) — unlink in QBO first" };
  }
  try {
    const closing = await getCompanyClosingDate(clientLink.qbo_realm_id, token);
    if (closing && live.TxnDate && live.TxnDate <= closing) {
      return { ok: false, error: `Dated ${live.TxnDate}, inside the closed period (books closed through ${closing})` };
    }
  } catch {}

  const method = VOIDABLE.has(map.entity) ? "void" : "delete";
  try {
    await qboRequest(
      clientLink.qbo_realm_id,
      token,
      `/${map.resource}?operation=${method}&minorversion=70`,
      { method: "POST", body: JSON.stringify({ Id: String(live.Id), SyncToken: String(live.SyncToken) }) }
    );
  } catch (e: any) {
    return { ok: false, error: `QuickBooks rejected the ${method}: ${e?.message || "unknown error"}` };
  }

  await svc
    .from("dup_findings")
    .update({
      status: "resolved",
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
      removed_txn_id: String(live.Id),
      removed_txn_type: txnType,
      removal_method: method,
      snapshot: live,
    })
    .eq("id", finding.id);

  try {
    await svc.from("audit_log").insert({
      event_type: "duplicate_removed",
      user_id: userId,
      request_payload: {
        dup_finding_id: finding.id,
        client_link_id: clientLink.id,
        client_name: clientLink.client_name,
        txn_id: String(live.Id),
        txn_type: txnType,
        amount: finding.amount,
        method,
        tier: finding.tier,
      },
    });
  } catch {}

  return { ok: true, method };
}
