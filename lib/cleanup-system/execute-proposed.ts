/**
 * Execute approved proposed entries — idempotent QBO writes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidToken, fetchAllAccounts, type QBOAccount } from "@/lib/qbo";
import {
  reclassifyTransactionLines,
  SUPPORTED_TX_TYPES,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { ensureAccountExists } from "@/lib/coa-reclass-je";
import { resolveAccount } from "@/lib/qbo-journal-entry";
import { applyUfPaymentToInvoice, applyApPaymentToBill, createJournalEntry, voidQboInvoice } from "./qbo-posting";
import { parseEntryMeta } from "./entry-meta";
import { CLEARING_ACCOUNT_NAME } from "./types";

export async function executeProposedEntries(
  service: SupabaseClient,
  runId: string,
  userId: string,
  module?: string,
  entryId?: string
): Promise<{ executed: number; failed: number; skipped: number }> {
  let query = service
    .from("proposed_entries")
    .select("*")
    .eq("run_id", runId)
    .eq("decision", "approved")
    .eq("executed", false);

  if (module) query = query.eq("module", module);
  // Scope to a single entry — used by the per-row "Approve & post" path so one
  // Approve click posts exactly that entry to QBO (the bulk module path omits
  // entryId and posts every approved-unexecuted entry in the module).
  if (entryId) query = query.eq("id", entryId);

  const { data: entries } = await query;
  if (!entries || entries.length === 0) {
    return { executed: 0, failed: 0, skipped: 0 };
  }

  const clientLinkId = (entries[0] as any).client_link_id;
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) throw new Error("Client not found");

  const accessToken = await getValidToken(clientLinkId, service);
  const realmId = (client as any).qbo_realm_id;

  // ── JE account resolution ──────────────────────────────────────────────
  // The bank-recon adjusting JE and every "clearing" offset line carry an
  // account NAME (account_hint), not an ID. QBO's AccountRef.value must be a
  // real account ID, so a JE built from hints 400s at QBO — historically these
  // entries could be approved but silently never posted (execution_error). We
  // resolve names -> IDs here, and get-or-create the cleanup clearing account
  // (which no module ever created), before posting. Accounts are fetched once
  // per run and cached. A hint that can't be resolved THROWS, so the entry is
  // recorded as failed rather than posted with a bad reference.
  let jeAccounts: QBOAccount[] | null = null;
  let clearingId: string | null = null;
  async function resolveJeAccountId(line: any): Promise<string> {
    if (line.qbo_account_id) return String(line.qbo_account_id);
    const hint = String(line.account_hint || "").trim();
    if (!hint) throw new Error("JE line has no account id or name hint");
    if (!jeAccounts) jeAccounts = await fetchAllAccounts(realmId, accessToken);
    if (hint.toLowerCase() === CLEARING_ACCOUNT_NAME.toLowerCase()) {
      if (!clearingId) {
        const acct = await ensureAccountExists({
          realmId, accessToken,
          name: CLEARING_ACCOUNT_NAME,
          accountType: "Other Current Asset",
          accountSubType: "OtherCurrentAssets",
          allAccounts: jeAccounts,
        });
        clearingId = acct.Id;
        if (!jeAccounts.some((a) => a.Id === acct.Id)) jeAccounts.push(acct);
      }
      return clearingId;
    }
    const r = resolveAccount(hint, jeAccounts as any);
    if (r.ok && r.qbo_account_id) return r.qbo_account_id;
    throw new Error(
      `Couldn't resolve JE account "${hint}" to a QuickBooks account${r.reason ? ` — ${r.reason}` : ""}. ` +
      `Set the target account on this entry and re-approve.`
    );
  }

  let executed = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of entries as any[]) {
    if (entry.period_impact === "cpa_blocked" && entry.cpa_flag_id) {
      const { data: flag } = await service
        .from("cpa_flags")
        .select("status")
        .eq("id", entry.cpa_flag_id)
        .single();
      if (!flag || (flag as any).status !== "signed_off") {
        skipped++;
        continue;
      }
    }

    try {
      let qboResultId: string | null = null;
      let handled = false;

      if (entry.entry_type === "receive_payment" && entry.qbo_transaction_id) {
        const meta = parseEntryMeta(entry.ai_reasoning);
        const invoiceId =
          entry.bookkeeper_override_target_id ||
          entry.to_account_id ||
          (meta?.type === "uf_match" ? meta.proposed_invoice_id : null);

        if (!invoiceId) {
          skipped++;
          continue;
        }

        const amount = Number(entry.amount || 0);
        if (amount <= 0) {
          skipped++;
          continue;
        }

        qboResultId = await applyUfPaymentToInvoice(realmId, accessToken, {
          paymentId: entry.qbo_transaction_id,
          invoiceId,
          amount,
          runId,
          entryId: entry.id,
        });
        handled = true;
      } else if (entry.entry_type === "bill_payment" && entry.qbo_transaction_id) {
        // AP mirror of receive_payment: link an existing BillPayment to the
        // proposed (or bookkeeper-overridden) Bill.
        const meta = parseEntryMeta(entry.ai_reasoning);
        const billId =
          entry.bookkeeper_override_target_id ||
          entry.to_account_id ||
          (meta?.type === "ap_match" ? meta.proposed_bill_id : null);
        const amount = Number(entry.amount || 0);
        if (!billId || amount <= 0) {
          skipped++;
          continue;
        }
        qboResultId = await applyApPaymentToBill(realmId, accessToken, {
          billPaymentId: entry.qbo_transaction_id,
          billId,
          amount,
          runId,
          entryId: entry.id,
        });
        handled = true;
      } else if (entry.entry_type === "void" && entry.qbo_transaction_id) {
        qboResultId = await voidQboInvoice(
          realmId,
          accessToken,
          entry.qbo_transaction_id,
          entry.memo || `BS Cleanup void ${runId}`
        );
        handled = true;
      } else if (entry.entry_type === "reclass" && entry.qbo_transaction_id) {
        const txType = (entry.qbo_transaction_type || "Expense") as SupportedTxType;
        if (!SUPPORTED_TX_TYPES.includes(txType)) {
          skipped++;
          continue;
        }
        const result = await reclassifyTransactionLines(realmId, accessToken, {
          txType,
          txId: entry.qbo_transaction_id,
          lineUpdates: [
            {
              line_id: entry.qbo_line_id || "1",
              new_account_id: entry.bookkeeper_override_target_id || entry.to_account_id,
              new_account_name: entry.bookkeeper_override_target_name || entry.to_account_name,
            },
          ],
          auditMemo: `BS Cleanup run ${runId}`,
        });
        qboResultId = result?.tx?.Id || entry.qbo_transaction_id;
        handled = true;
      } else if (
        (entry.entry_type === "journal_entry" || entry.period_impact === "clearing_entry") &&
        entry.je_lines &&
        entry.txn_date
      ) {
        const lines: Array<{ account_id: string; posting_type: "Debit" | "Credit"; amount: number; description?: string }> = [];
        for (const l of (entry.je_lines as any[])) {
          lines.push({
            account_id: await resolveJeAccountId(l),
            posting_type: (l.side === "debit" ? "Debit" : "Credit") as "Debit" | "Credit",
            amount: Number(l.amount),
            description: l.description || entry.memo,
          });
        }

        const je = await createJournalEntry(realmId, accessToken, {
          txn_date: entry.txn_date,
          private_note: entry.memo || `BS Cleanup ${runId}`,
          lines,
        });
        qboResultId = je?.Id || null;
        handled = true;
      }

      if (!handled) {
        skipped++;
        continue;
      }

      await service
        .from("proposed_entries")
        .update({
          executed: true,
          executed_at: new Date().toISOString(),
          executed_by: userId,
          qbo_result_id: qboResultId,
          execution_error: null,
        } as any)
        .eq("id", entry.id);

      await service.from("audit_log").insert({
        event_type: "cleanup_entry_executed",
        user_id: userId,
        occurred_at: new Date().toISOString(),
        request_payload: {
          run_id: runId,
          entry_id: entry.id,
          entry_type: entry.entry_type,
          idempotency_key: entry.idempotency_key,
          qbo_result_id: qboResultId,
        },
      } as any);

      executed++;
    } catch (err: any) {
      await service
        .from("proposed_entries")
        .update({ execution_error: err.message } as any)
        .eq("id", entry.id);
      failed++;
    }
  }

  return { executed, failed, skipped };
}
