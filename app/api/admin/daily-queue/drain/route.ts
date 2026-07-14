import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, reclassifyTransactionLines, getCompanyClosingDate, type SupportedTxType, SUPPORTED_TX_TYPES } from "@/lib/qbo-reclass";
import { fetchAllAccounts } from "@/lib/qbo";
import { lookupVendor } from "@/lib/vendor-knowledge";
import { sameAccount } from "@/lib/vendor-remediation";

/**
 * POST /api/admin/daily-queue/drain
 *
 * One-shot backlog drain (Mike, 2026-07-13): the 0.95 auto-execute floor
 * queued ~1,000 items that the REVIEWED vendor rules (0.90+) would have
 * auto-posted. Re-scores every pending daily_review_queue row against the
 * current KB and executes the confident ones through the SAME write path the
 * /today queue buttons use — with the remediation guards: closed periods
 * skipped, stale guard (line must still be in its from-account), per-client
 * amount threshold. Everything else stays pending for humans.
 *
 * Budget-chunked: returns remaining>0 when time runs out; click again.
 */
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const FLOOR = 0.90;

export async function POST() {
  const start = Date.now();
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  // Pending queue, grouped per client (one token + account list + closing date
  // each). NOTE: no PostgREST embed here — daily_review_queue has no FK to
  // client_links, so `client_links(...)` silently errors and the drain
  // reported "0 scanned, complete" over 2,253 pending rows (Mike, 2026-07-14).
  // Join in code instead, and CHECK the error.
  const { data: pending, error: pendErr } = await (service as any)
    .from("daily_review_queue")
    .select("*")
    .eq("decision", "pending")
    .order("created_at", { ascending: true })
    .limit(2000);
  if (pendErr) return NextResponse.json({ error: `queue read failed: ${pendErr.message}` }, { status: 500 });
  const { data: clientRows, error: clErr } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, industry, auto_approve_threshold, is_active")
    .eq("is_active", true);
  if (clErr) return NextResponse.json({ error: `clients read failed: ${clErr.message}` }, { status: 500 });
  const clientById = new Map((clientRows || []).map((c: any) => [c.id, c]));
  const rows = (pending || [])
    .map((r: any) => ({ ...r, client_links: clientById.get(r.client_link_id) }))
    .filter((r: any) => r.client_links?.qbo_realm_id);

  const byClient = new Map<string, any[]>();
  for (const r of rows) (byClient.get(r.client_link_id) ?? byClient.set(r.client_link_id, []).get(r.client_link_id)!).push(r);

  const summary = { scanned: rows.length, executed: 0, left_for_review: 0, skipped_closed: 0, skipped_stale: 0, failed: 0, remaining: 0 };

  outer:
  for (const [clientId, items] of byClient) {
    if (Date.now() - start > BUDGET_MS) { summary.remaining += items.length; continue; }
    const link = items[0].client_links;
    const threshold = link.auto_approve_threshold || 500;
    let accessToken: string, accounts: any[], closingDate: string | null;
    try {
      accessToken = await getValidToken(clientId, service as any);
      accounts = await fetchAllAccounts(link.qbo_realm_id, accessToken);
      closingDate = await getCompanyClosingDate(link.qbo_realm_id, accessToken);
    } catch (err: any) {
      console.warn(`[queue-drain] ${link.client_name}: setup failed (${err.message}) — leaving items pending`);
      summary.left_for_review += items.length;
      continue;
    }
    const findAccount = (name: string) =>
      accounts.find((a) => a.Active !== false && sameAccount(a.FullyQualifiedName || a.Name, name)) ||
      accounts.find((a) => a.Active !== false && sameAccount(a.Name, name));

    for (const r of items) {
      if (Date.now() - start > BUDGET_MS) { summary.remaining++; continue; }
      const amt = r.transaction_amount ?? 0;
      const kb = lookupVendor(r.vendor_name || "", r.description || "", amt, link.industry || "painters");
      if (!kb || kb.confidence < FLOOR || Math.abs(amt) >= threshold ||
          !SUPPORTED_TX_TYPES.includes(r.qbo_transaction_type as SupportedTxType) || !r.qbo_line_id) {
        summary.left_for_review++;
        continue;
      }
      if (closingDate && r.transaction_date && r.transaction_date <= closingDate) { summary.skipped_closed++; continue; }
      const target = findAccount(kb.account);
      if (!target || sameAccount(kb.account, r.from_account_name)) { summary.left_for_review++; continue; }
      try {
        const result = await reclassifyTransactionLines(link.qbo_realm_id, accessToken, {
          txType: r.qbo_transaction_type as SupportedTxType,
          txId: r.qbo_transaction_id,
          lineUpdates: [{
            line_id: r.qbo_line_id,
            new_account_id: target.Id,
            new_account_name: target.Name,
            expected_current_account_name: r.from_account_name, // stale guard
          }],
          auditMemo: `SNAP daily recon (reviewed vendor rules, backlog drain ${new Date().toISOString().slice(0, 10)})`,
          vendorName: kb.vendor || null,
        });
        if (result.lines_applied === 0) { summary.skipped_stale++; continue; }
        await (service as any).from("daily_review_queue").update({
          decision: "executed",
          decided_by: user.id,
          decided_at: new Date().toISOString(),
          executed_at: new Date().toISOString(),
          suggested_account_id: target.Id,
          suggested_account_name: target.Name,
          ai_confidence: kb.confidence,
          ai_reasoning: `${kb.reasoning} — auto-executed by reviewed-rules backlog drain`,
        }).eq("id", r.id);
        summary.executed++;
      } catch (err: any) {
        summary.failed++;
        console.error(`[queue-drain] ${link.client_name} ${r.qbo_transaction_type}/${r.qbo_transaction_id}: ${err.message}`);
      }
    }
  }

  await service.from("audit_log").insert({
    event_type: "daily_queue_drain",
    user_id: user.id,
    request_payload: summary as any,
  } as any);
  return NextResponse.json(summary);
}
