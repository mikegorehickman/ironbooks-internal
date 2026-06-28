import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, reclassifyTransactionLines } from "@/lib/qbo-reclass";
import { upsertActivateRule } from "@/lib/bank-rules";

export const dynamic = "force-dynamic";
// Bulk approve may need to ship 30+ QBO writes serially per realm
// (rate limits) — give it real time. 120s ≈ ~80 writes if each takes 1.5s.
export const maxDuration = 120;

/**
 * POST /api/daily-recon/queue/bulk
 *
 * Bulk action across multiple daily_review_queue rows. Built for the
 * sr's "approve all selected" workflow on /today/[clientId] — clicking
 * 30 individual rows wasted 5 minutes per client every morning.
 *
 * Body:
 *   {
 *     ids: string[],                              // row ids to act on
 *     action: "approve" | "reject" | "ask_client",
 *     reason?: string                             // optional, only for reject
 *   }
 *
 * Per-row behavior matches the single-row PATCH endpoint at
 * /api/daily-recon/queue/[id]:
 *   - approve     → push the row's existing suggested_account to QBO,
 *                   mark 'executed'. (Per-row override is not supported
 *                   in bulk — bookkeeper should approve those individually
 *                   so they're forced to look at the override.)
 *   - reject      → mark 'rejected', no QBO write
 *   - ask_client  → mark 'ask_client', no QBO write
 *
 * Returns per-row outcome so the UI can show a tidy summary:
 *   { ok: true, summary: { succeeded: 12, failed: 1, skipped: 0 },
 *     results: [{ id, status: "executed"|"failed"|"skipped", error? }] }
 *
 * Auth: owner bookkeeper of each client, OR admin/lead.
 * We do this per-row so a single approve list crossing multiple clients
 * still enforces row-level permission.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { ids?: unknown; action?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = String(body.action || "");
  if (!["approve", "reject", "ask_client"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "No ids provided" }, { status: 400 });
  }
  if (ids.length > 200) {
    // Vercel function timeout protection — at ~1.5s/QBO-write, 200 takes
    // 5 minutes. Force the bookkeeper into batches above that.
    return NextResponse.json(
      { error: "Bulk action limited to 200 rows per request — split into batches." },
      { status: 400 }
    );
  }

  const reason = typeof body.reason === "string" ? body.reason : null;
  const createRules = (body as any).create_rules === true;

  const service = createServiceSupabase();

  // Pull actor role once so we can short-circuit owner checks
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  const isSenior = ["admin", "lead"].includes(role);

  // Pull all the rows in one query — much faster than per-id lookups
  const { data: rows } = await service
    .from("daily_review_queue" as any)
    .select(
      "id, client_link_id, decision, qbo_transaction_id, qbo_transaction_type, qbo_line_id, vendor_name, description, transaction_amount, suggested_account_id, suggested_account_name, client_links!inner(id, qbo_realm_id, assigned_bookkeeper_id)"
    )
    .in("id", ids);

  const rowsArr = (rows as any[]) || [];
  const rowById = new Map(rowsArr.map((r) => [r.id, r]));

  // Cache realm → access token so we only refresh once per client even
  // if 30 rows belong to the same realm.
  const tokenCache = new Map<string, string>();

  const results: Array<{ id: string; status: string; error?: string }> = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const id of ids) {
    const r = rowById.get(id);
    if (!r) {
      results.push({ id, status: "not_found" });
      skipped++;
      continue;
    }
    if (r.decision !== "pending") {
      results.push({ id, status: "already_decided" });
      skipped++;
      continue;
    }
    const isOwner = r.client_links?.assigned_bookkeeper_id === user.id;
    if (!isOwner && !isSenior) {
      results.push({ id, status: "forbidden" });
      skipped++;
      continue;
    }

    if (action === "reject" || action === "ask_client") {
      const updates: any = {
        decision: action === "reject" ? "rejected" : "ask_client",
        decided_by: user.id,
        decided_at: now,
      };
      if (action === "reject" && reason) {
        updates.ai_reasoning = `Rejected: ${reason}`;
      }
      const { error } = await service
        .from("daily_review_queue" as any)
        .update(updates)
        .eq("id", id);
      if (error) {
        results.push({ id, status: "failed", error: error.message });
        failed++;
      } else {
        results.push({ id, status: action === "reject" ? "rejected" : "ask_client" });
        succeeded++;
      }
      continue;
    }

    // ── approve ──
    if (!r.suggested_account_id || !r.suggested_account_name) {
      results.push({
        id,
        status: "failed",
        error: "No target account assigned — approve individually with override",
      });
      failed++;
      continue;
    }

    try {
      let accessToken = tokenCache.get(r.client_link_id);
      if (!accessToken) {
        accessToken = await getValidToken(r.client_link_id, service as any);
        tokenCache.set(r.client_link_id, accessToken);
      }

      await reclassifyTransactionLines(
        r.client_links.qbo_realm_id,
        accessToken,
        {
          txType: r.qbo_transaction_type,
          txId: r.qbo_transaction_id,
          lineUpdates: [
            {
              line_id: r.qbo_line_id,
              new_account_id: r.suggested_account_id,
              new_account_name: r.suggested_account_name,
            },
          ],
          auditMemo: `Ironbooks daily recon — bulk approved by bookkeeper`,
        }
      );

      await service
        .from("daily_review_queue" as any)
        .update({
          decision: "executed",
          decided_by: user.id,
          decided_at: now,
          executed_at: now,
        } as any)
        .eq("id", id);

      // Learning loop (best-effort) — teach a rule so this vendor
      // auto-categorizes next run.
      if (createRules && r.vendor_name) {
        try {
          await upsertActivateRule(service as any, {
            client_link_id: r.client_link_id,
            vendor: r.vendor_name,
            target_account_name: r.suggested_account_name,
            created_by: user.id,
            sample_descriptions: r.description ? [String(r.description)] : [],
            transaction_count: 1,
            total_amount: r.transaction_amount || 0,
          });
        } catch {
          /* rule hiccup never fails the approve */
        }
      }

      results.push({ id, status: "executed" });
      succeeded++;
    } catch (err: any) {
      results.push({ id, status: "failed", error: err?.message || String(err) });
      failed++;
    }
  }

  // Audit log — useful when a bulk action goes sideways and we want to
  // see exactly what was attempted.
  await service.from("audit_log").insert({
    event_type: "daily_recon_bulk_action",
    user_id: user.id,
    request_payload: {
      action,
      requested_ids: ids,
      summary: { succeeded, failed, skipped },
      failures: results.filter((r) => r.status === "failed" || r.status === "forbidden"),
    } as any,
  });

  return NextResponse.json({
    ok: true,
    summary: { succeeded, failed, skipped, total: ids.length },
    results,
  });
}
