import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboRequest, qboErrorResponse, voidPayment, fetchAllAccounts, createJournalEntry } from "@/lib/qbo";
import { ensureAccountExists } from "@/lib/coa-reclass-je";

/**
 * POST /api/clients/[id]/ucpi/[resolutionId]/resolve   { dry_run? (default TRUE) }
 *
 * Executes an ANSWERED UCPI question's resolution against QBO. dry_run defaults
 * TRUE — you must pass dry_run:false to write. Owner bookkeeper or admin/lead.
 *
 *   void                 → voidPayment on each unapplied payment (never real income)
 *   apply_to_invoice     → apply the unapplied payment to the open invoice(s),
 *                          oldest first, up to each invoice's balance (moves it
 *                          out of UCPI into real revenue)
 *   to_deposit_liability → ensure a "Customer Deposits" (Other Current Liability)
 *                          account, then reclass the unapplied amount off income
 *                          onto it via a balanced JE (unearned — not revenue)
 *   manual               → no write; the bookkeeper finishes it in QBO
 *
 * NB: the apply + deposit-liability QBO writes are new and have NOT been
 * exercised against a live file yet — run dry_run first and eyeball the plan
 * (Dominion is the first live case). Snapshots every entity before writing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const UCPI_MEMO = "SNAP UCPI resolution";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; resolutionId: string }> }
) {
  const { id: clientLinkId, resolutionId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const dryRun = body.dry_run !== false; // default TRUE

  const { data: row } = await (service as any)
    .from("ucpi_resolutions")
    .select("*")
    .eq("id", resolutionId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!row) return NextResponse.json({ error: "UCPI question not found" }, { status: 404 });
  if (row.status !== "answered") {
    return NextResponse.json({ error: `Question is "${row.status}" — only an ANSWERED question can be resolved` }, { status: 409 });
  }

  const realm = (client as any).qbo_realm_id as string;
  const paymentIds: string[] = Array.isArray(row.payment_ids) ? row.payment_ids.map(String) : [];
  const openInvoices: { invoice_id: string; balance: number; date: string; doc_number?: string | null }[] =
    Array.isArray(row.open_invoices) ? row.open_invoices : [];
  const memo = `${UCPI_MEMO}: ${row.resolution} by ${(actor as any)?.full_name || "staff"}`;

  const summary: any = { dry_run: dryRun, resolution: row.resolution, payments: paymentIds.length, actions: [] as string[], failures: [] as string[] };
  const snapshot = async (kind: string, id: string, entity: any) => {
    await service.from("audit_log").insert({
      event_type: "ucpi_resolve_snapshot",
      user_id: user.id,
      request_payload: { client_link_id: clientLinkId, resolution_id: resolutionId, kind, txn_id: id, entity } as any,
    } as any);
  };

  try {
    const token = await getValidToken(clientLinkId, service as any);

    if (row.resolution === "manual") {
      summary.actions.push("manual — no QBO write; finish in QuickBooks");
    } else if (row.resolution === "void") {
      for (const pid of paymentIds) {
        if (dryRun) { summary.actions.push(`would void Payment ${pid}`); continue; }
        try {
          const cur = await qboRequest<any>(realm, token, `/payment/${pid}?minorversion=70`);
          await snapshot("Payment", pid, cur?.Payment);
          await voidPayment(realm, token, pid, "Payment");
          summary.actions.push(`voided Payment ${pid}`);
        } catch (e: any) { summary.failures.push(`void ${pid}: ${String(e?.message || e).slice(0, 200)}`); }
      }
    } else if (row.resolution === "apply_to_invoice") {
      // Apply each unapplied payment onto the open invoice(s), oldest first.
      const invoices = [...openInvoices].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      for (const pid of paymentIds) {
        try {
          const cur = (await qboRequest<any>(realm, token, `/payment/${pid}?minorversion=70`))?.Payment;
          if (!cur) { summary.failures.push(`payment ${pid} not found`); continue; }
          let unapplied = Number(cur.UnappliedAmt) || 0;
          if (unapplied <= 0.005) { summary.actions.push(`Payment ${pid} already fully applied — skipped`); continue; }
          const newLines = [...(cur.Line || [])];
          const applied: string[] = [];
          for (const inv of invoices) {
            if (unapplied <= 0.005) break;
            const take = Math.min(unapplied, Number(inv.balance) || 0);
            if (take <= 0.005) continue;
            newLines.push({ Amount: Math.round(take * 100) / 100, LinkedTxn: [{ TxnId: inv.invoice_id, TxnType: "Invoice" }] });
            unapplied = Math.round((unapplied - take) * 100) / 100;
            applied.push(`inv ${inv.doc_number || inv.invoice_id} $${take}`);
          }
          if (applied.length === 0) { summary.actions.push(`Payment ${pid}: no open invoice balance to apply to`); continue; }
          if (dryRun) { summary.actions.push(`would apply Payment ${pid} → ${applied.join(", ")}`); continue; }
          await snapshot("Payment", pid, cur);
          await qboRequest<any>(realm, token, `/payment?minorversion=70`, {
            method: "POST",
            body: JSON.stringify({ ...cur, Line: newLines, PrivateNote: appendMemo(cur.PrivateNote, memo) }),
          });
          summary.actions.push(`applied Payment ${pid} → ${applied.join(", ")}`);
        } catch (e: any) { summary.failures.push(`apply ${pid}: ${String(e?.message || e).slice(0, 200)}`); }
      }
    } else if (row.resolution === "to_deposit_liability") {
      const amount = Math.round((Number(row.unapplied_amount) || 0) * 100) / 100;
      const accounts = await fetchAllAccounts(realm, token);
      const ucpiAcct = accounts.find((a) => /unapplied cash payment income/i.test(a.Name || ""));
      if (!ucpiAcct) { summary.failures.push('no "Unapplied Cash Payment Income" account found — can\'t reclass'); }
      else if (dryRun) {
        summary.actions.push(`would ensure "Customer Deposits" (Other Current Liability) + JE $${amount}: Dr "${ucpiAcct.Name}" / Cr Customer Deposits`);
      } else {
        const dep = await ensureAccountExists({ realmId: realm, accessToken: token, name: "Customer Deposits", accountType: "Other Current Liability", accountSubType: "OtherCurrentLiabilities", allAccounts: accounts });
        // Balanced JE: move the unearned amount off income onto the liability.
        await createJournalEntry(realm, token, {
          txn_date: new Date().toISOString().slice(0, 10),
          private_note: memo,
          lines: [
            { posting_type: "Debit", amount, account_id: ucpiAcct.Id, description: memo },
            { posting_type: "Credit", amount, account_id: dep.Id, description: memo },
          ],
        });
        summary.actions.push(`reclassed $${amount} → Customer Deposits (${dep.Name})`);
      }
    }

    if (!dryRun && summary.failures.length === 0) {
      await (service as any).from("ucpi_resolutions").update({
        status: "resolved", resolved_at: new Date().toISOString(), resolved_by: user.id,
        resolution_detail: { ...(row.resolution_detail || {}), executed: summary.actions }, updated_at: new Date().toISOString(),
      }).eq("id", resolutionId);
    }
    return NextResponse.json({ ok: summary.failures.length === 0, ...summary });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}

function appendMemo(existing: string | null | undefined, memo: string): string {
  const e = existing || "";
  return e.includes(memo) ? e : (e ? e + "\n" : "") + memo;
}
