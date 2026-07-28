import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccounts, qboErrorResponse } from "@/lib/qbo";
import { fetchAllTransactionLines, getCompanyClosingDate } from "@/lib/qbo-reclass";

/**
 * POST /api/admin/coa-parent-postings/transactions   (READ-ONLY)
 *   { client_link_id, parent_account_id, start?, end? }
 *
 * Lists the individual transactions posted DIRECTLY on a parent account, so a
 * bookkeeper can split them across the right sub-accounts instead of dumping
 * every one onto a single child (the old all-or-nothing "Move" button).
 *
 * Deliberately reuses the reclass engine's own fetch + the same id-based filter
 * the fixer uses, so what you see here is exactly the set the fixer can move —
 * no drift between preview and write. It does NOT use the TransactionList
 * report's `account=` filter, which QBO silently ignores (returns the whole
 * period) and which has produced inflated counts elsewhere in the app.
 *
 * Admin / lead — same gate as the fixer.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  const parentId = String(body.parent_account_id || "").trim();
  if (!clientLinkId || !parentId) {
    return NextResponse.json({ error: "client_link_id and parent_account_id required" }, { status: 400 });
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
    if (!parent) return NextResponse.json({ error: "Parent account not found" }, { status: 404 });

    // Candidate targets = this parent's active sub-accounts.
    const children = accounts
      .filter((a) => a.Active !== false && String(a.ParentRef?.value || "") === parentId)
      .map((a) => ({ id: String(a.Id), name: a.Name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const year = new Date().getFullYear();
    const start = String(body.start || `${year}-01-01`).slice(0, 10);
    const end = String(body.end || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const closingDate = await getCompanyClosingDate(realm, token).catch(() => null);

    const { lines } = await fetchAllTransactionLines(realm, token, start, end);
    const parentLines = lines.filter((l) => String(l.current_account_id) === parentId);

    // One row per transaction — a transaction can carry several lines on the
    // parent, and the fixer moves them together, so the UI must too.
    const byTxn = new Map<
      string,
      {
        txn_key: string;
        tx_type: string;
        tx_id: string;
        date: string;
        vendor: string;
        description: string;
        amount: number;
        line_ids: string[];
        is_reconciled: boolean;
        in_closed_period: boolean;
      }
    >();
    for (const l of parentLines) {
      const key = `${l.transaction_type}::${l.transaction_id}`;
      const g = byTxn.get(key) || {
        txn_key: key,
        tx_type: l.transaction_type,
        tx_id: l.transaction_id,
        date: l.transaction_date,
        vendor: l.vendor_name || "",
        description: l.description || l.private_note || "",
        amount: 0,
        line_ids: [] as string[],
        is_reconciled: false,
        in_closed_period: false,
      };
      if (l.line_id) g.line_ids.push(l.line_id);
      g.amount = Math.round((g.amount + (Number(l.transaction_amount) || 0)) * 100) / 100;
      if (l.is_reconciled) g.is_reconciled = true;
      if (!g.description && l.description) g.description = l.description;
      byTxn.set(key, g);
    }

    const txns = [...byTxn.values()]
      .map((t) => ({
        ...t,
        in_closed_period: !!(closingDate && t.date && t.date <= closingDate),
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : Math.abs(b.amount) - Math.abs(a.amount)));

    return NextResponse.json({
      client_name: (client as any).client_name,
      parent: { id: parentId, name: parent.Name },
      children,
      window: { start, end },
      closing_date: closingDate,
      txns,
      total_amount: Math.round(txns.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
