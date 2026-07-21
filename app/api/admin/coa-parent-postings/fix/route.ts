import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchAllTransactionLines, reclassifyTransactionLines, getCompanyClosingDate, type SupportedTxType } from "@/lib/qbo-reclass";

/**
 * POST /api/admin/coa-parent-postings/fix   (WRITES TO QBO)
 *   { client_link_id, parent_account_id, child_account_id, dry_run? (default TRUE) }
 *
 * Moves the DIRECT postings sitting on a parent account down onto one of its
 * sub-accounts. Reuses the reclass engine: pull YTD lines, keep only those
 * whose AccountRef is the PARENT id (id-based — reliable), and re-point them to
 * the child. The parent stays (it's still a heading); only its stray postings
 * move. Closed-period lines are skipped. dry_run defaults TRUE. Admin / lead.
 *
 * Covers expense-family postings (Bill/Purchase/Expense/VendorCredit — what the
 * reclass engine fetches); JE/Deposit postings on a parent are out of scope and
 * reported as untouched via the summary counts.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const MAX_TXNS_PER_PASS = 80;

export async function POST(request: Request) {
  const startTime = Date.now();
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  const parentId = String(body.parent_account_id || "").trim();
  const childId = String(body.child_account_id || "").trim();
  const dryRun = body.dry_run !== false; // default TRUE — must opt in to write
  if (!clientLinkId || !parentId || !childId) {
    return NextResponse.json({ error: "client_link_id, parent_account_id, child_account_id required" }, { status: 400 });
  }
  if (parentId === childId) {
    return NextResponse.json({ error: "child must differ from the parent" }, { status: 400 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!(client as any)?.qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);

    const accounts = await fetchAllAccounts(realm, token);
    const parent = accounts.find((a) => a.Id === parentId);
    const child = accounts.find((a) => a.Id === childId);
    if (!parent) return NextResponse.json({ error: "Parent account not found" }, { status: 404 });
    if (!child || child.Active === false) return NextResponse.json({ error: "Child account not found or inactive" }, { status: 400 });
    // Safety: the target should be a sub-account of this parent — the whole
    // point is moving a parent's stray postings onto its own child.
    if (String(child.ParentRef?.value || "") !== parentId) {
      return NextResponse.json({ error: `"${child.Name}" is not a sub-account of "${parent.Name}"` }, { status: 400 });
    }

    const year = new Date().getFullYear();
    const ytdStart = `${year}-01-01`;
    const ytdEnd = new Date().toISOString().slice(0, 10);
    const closingDate = await getCompanyClosingDate(realm, token).catch(() => null);

    const { lines } = await fetchAllTransactionLines(realm, token, ytdStart, ytdEnd);
    // Id-based filter — the parent's OWN postings (sub-account lines carry the
    // child's id, not the parent's).
    const parentLines = lines.filter((l) => String(l.current_account_id) === parentId);

    // Group the parent's lines by transaction.
    const byTxn = new Map<string, { txType: SupportedTxType; txId: string; lineIds: string[]; amount: number; date: string }>();
    for (const l of parentLines) {
      const key = `${l.transaction_type}::${l.transaction_id}`;
      const g = byTxn.get(key) || { txType: l.transaction_type as SupportedTxType, txId: l.transaction_id, lineIds: [], amount: 0, date: l.transaction_date };
      if (l.line_id) g.lineIds.push(l.line_id);
      g.amount = Math.round((g.amount + (Number(l.transaction_amount) || 0)) * 100) / 100;
      byTxn.set(key, g);
    }
    const txns = [...byTxn.values()];
    const totalAmount = Math.round(txns.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100;

    const summary = {
      dry_run: dryRun,
      parent: parent.Name,
      child: child.Name,
      txns_found: txns.length,
      lines_found: parentLines.length,
      amount_found: totalAmount,
      moved_txns: 0,
      moved_lines: 0,
      skipped_closed: 0,
      failed: 0,
      remaining: 0,
    };

    if (dryRun) {
      return NextResponse.json(summary);
    }

    const memo = `Ironbooks: moved off parent "${parent.Name}" → "${child.Name}" (by ${(actor as any)?.full_name || "staff"})`;
    for (let i = 0; i < txns.length; i++) {
      if (Date.now() - startTime > BUDGET_MS || i >= MAX_TXNS_PER_PASS) {
        summary.remaining = txns.length - i;
        break;
      }
      const t = txns[i];
      if (closingDate && t.date && t.date <= closingDate) { summary.skipped_closed++; continue; }
      try {
        const r = await reclassifyTransactionLines(realm, token, {
          txType: t.txType,
          txId: t.txId,
          lineUpdates: t.lineIds.map((line_id) => ({
            line_id,
            new_account_id: childId,
            new_account_name: child.Name,
            expected_current_account_name: parent.Name, // stale guard
          })),
          auditMemo: memo,
        });
        if (r.lines_applied > 0) { summary.moved_txns++; summary.moved_lines += r.lines_applied; }
      } catch (e: any) {
        summary.failed++;
      }
    }

    await service.from("audit_log").insert({
      event_type: "coa_parent_posting_fix",
      user_id: user.id,
      request_payload: { client_link_id: clientLinkId, client_name: (client as any).client_name, parent_id: parentId, child_id: childId, ...summary } as any,
    } as any);

    return NextResponse.json(summary);
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
