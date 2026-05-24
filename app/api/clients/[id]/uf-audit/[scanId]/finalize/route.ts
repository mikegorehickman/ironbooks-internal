import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { createJournalEntry, fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { findUndepositedFundsAccountId } from "@/lib/qbo-balance-sheet";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * POST /api/clients/[id]/uf-audit/[scanId]/finalize
 *
 * Execute every orphan with a JE-creating resolution (owner_draw, write_off).
 * Strategy:
 *   - One JE per (customer_qbo_id, resolution, target_account_id) group.
 *     Cleaner audit trail than one JE per payment, and faster.
 *   - JE format: one credit line to UF for each orphan payment, one debit
 *     line to the target (Owner Draw / Bad Debt / etc) summing to the total.
 *
 * Other resolutions:
 *   - duplicate_recategorize / ask_client / manual_investigation → marked
 *     resolved (no QBO write); bookkeeper handles externally.
 *
 * Owner bookkeeper or admin/lead only.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: scan } = await service
    .from("uf_audit_scans" as any)
    .select("*")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });

  // Pull all orphan items with a non-pending resolution that hasn't been executed yet
  const { data: items } = await service
    .from("uf_audit_items" as any)
    .select("*")
    .eq("scan_id", scanId)
    .eq("classification", "orphan")
    .neq("resolution", "pending")
    .neq("resolution", "executed")
    .neq("resolution", "failed");
  const queue = (items as any[]) || [];

  if (queue.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No resolved orphans to execute.",
      executed: 0,
      failed: 0,
    });
  }

  let accessToken: string;
  let ufAccountId: string | null;
  let allAccounts;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
    allAccounts = await fetchAllAccounts((client as any).qbo_realm_id, accessToken);
    ufAccountId =
      (scan as any).uf_account_qbo_id ||
      (await findUndepositedFundsAccountId((client as any).qbo_realm_id, accessToken));
    if (!ufAccountId) throw new Error("Undeposited Funds account not found");
  } catch (err: any) {
    return NextResponse.json(
      { error: `QBO bootstrap failed: ${err?.message || String(err)}` },
      { status: 500 }
    );
  }
  const accountById = new Map(allAccounts.map((a) => [a.Id, a]));
  const ufAccount = accountById.get(ufAccountId);
  const ufAccountName = ufAccount?.Name || "Undeposited Funds";

  await service
    .from("uf_audit_scans" as any)
    .update({ status: "finalizing" } as any)
    .eq("id", scanId);

  const bookkeeperName = (actor as any)?.full_name || "bookkeeper";
  const today = new Date().toISOString().slice(0, 10);

  // Resolutions that don't write to QBO — just mark executed.
  const NON_QBO_RESOLUTIONS = new Set([
    "duplicate_recategorize",
    "ask_client",
    "manual_investigation",
  ]);

  // For QBO-writing resolutions (owner_draw, write_off), group by
  // (resolution, target_account_id, customer_qbo_id) so each group
  // gets one balanced JE.
  type GroupKey = string;
  const groups = new Map<GroupKey, any[]>();
  const noTargetItems: any[] = [];

  for (const item of queue) {
    if (NON_QBO_RESOLUTIONS.has(item.resolution)) continue;
    if (!item.resolution_target_account_id) {
      noTargetItems.push(item);
      continue;
    }
    const key = [
      item.resolution,
      item.resolution_target_account_id,
      item.customer_qbo_id || "_unknown_",
    ].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  let executed = 0;
  let failed = 0;
  const results: any[] = [];

  // 1) Mark non-QBO resolutions as executed
  for (const item of queue) {
    if (NON_QBO_RESOLUTIONS.has(item.resolution)) {
      await service
        .from("uf_audit_items" as any)
        .update({
          resolution: "executed",
          resolved_at: new Date().toISOString(),
        } as any)
        .eq("id", item.id);
      executed++;
      results.push({ id: item.id, status: "ok", type: "no-op" });
    }
  }

  // 2) Mark items lacking a target as failed with a clear message
  for (const item of noTargetItems) {
    await service
      .from("uf_audit_items" as any)
      .update({
        resolution: "failed",
        execution_error: "No target account selected — pick one before finalizing.",
      } as any)
      .eq("id", item.id);
    failed++;
    results.push({ id: item.id, status: "failed", error: "missing target account" });
  }

  // 3) Post one JE per group
  for (const [key, items] of groups) {
    const sample = items[0];
    const target = accountById.get(sample.resolution_target_account_id);
    if (!target) {
      // Mark every item in this group failed
      for (const it of items) {
        await service
          .from("uf_audit_items" as any)
          .update({
            resolution: "failed",
            execution_error: `Target account ${sample.resolution_target_account_id} not found in QBO`,
          } as any)
          .eq("id", it.id);
        failed++;
        results.push({ id: it.id, status: "failed", error: "target not found" });
      }
      continue;
    }

    // Compute total (sum of payment_amount) — must equal sum of UF credit lines
    const total =
      Math.round(
        items.reduce((s, it) => s + Number(it.payment_amount || 0), 0) * 100
      ) / 100;

    // JE design:
    //   Dr  <target>   (one line, total amount)
    //   Cr  UF          (one line per orphan payment, with payment date in memo)
    // This keeps the audit trail clean: each UF credit line names which
    // payment it's clearing.
    const debitLines = [
      {
        posting_type: "Debit" as const,
        amount: total,
        account_id: target.Id,
        account_name: target.Name,
        description: `Clear ${items.length} orphan UF payment${items.length === 1 ? "" : "s"} from ${sample.customer_name || "(no customer)"}`,
      },
    ];
    const creditLines = items.map((it: any) => ({
      posting_type: "Credit" as const,
      amount: Math.round(Number(it.payment_amount) * 100) / 100,
      account_id: ufAccountId!,
      account_name: ufAccountName,
      description: `Orphan Payment ${it.qbo_payment_id} (${it.payment_date}, ${it.customer_name || "(no customer)"})`,
    }));

    try {
      const created = await createJournalEntry((client as any).qbo_realm_id, accessToken, {
        txn_date: today,
        private_note: `Ironbooks UF Audit (by ${bookkeeperName}) — ${sample.resolution} for ${sample.customer_name || "(no customer)"}`,
        lines: [...debitLines, ...creditLines],
      });

      for (const it of items) {
        await service
          .from("uf_audit_items" as any)
          .update({
            resolution: "executed",
            resolution_je_id: created.Id,
            resolved_at: new Date().toISOString(),
          } as any)
          .eq("id", it.id);
        executed++;
      }
      results.push({
        group: key,
        je_id: created.Id,
        status: "ok",
        items: items.length,
        total,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      for (const it of items) {
        await service
          .from("uf_audit_items" as any)
          .update({ resolution: "failed", execution_error: msg } as any)
          .eq("id", it.id);
        failed++;
      }
      results.push({ group: key, status: "failed", error: msg, items: items.length });
    }
  }

  const finalStatus = failed > 0 && executed === 0 ? "failed" : "finalized";
  await service
    .from("uf_audit_scans" as any)
    .update({
      status: finalStatus,
      finalized_at: new Date().toISOString(),
      finalized_by: user.id,
      finalize_results: { executed, failed, results },
    } as any)
    .eq("id", scanId);

  return NextResponse.json({ ok: true, executed, failed, results });
}
