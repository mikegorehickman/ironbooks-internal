import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, voidInvoice, voidPayment, fetchAllAccounts } from "@/lib/qbo";
import { getCompanyClosingDate } from "@/lib/qbo-reclass";
import { buildRemediationPreview } from "@/lib/crm-invoice-remediation-preview";
import { applyDepositToInvoice, findArAccount, findFeeAccount, matchDepositToInvoicePayment } from "@/lib/crm-invoice-apply";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const MAX_PER_PASS = 40;

/**
 * POST /api/admin/crm-invoice-remediation/apply   (WRITES TO QBO)
 *   { client_link_id, start?, end?, invoice_ids: string[],
 *     dry_run?: boolean (default TRUE), allow_review?: boolean (default false) }
 *
 * DEFAULT (`match`, Mike 2026-07-28): for each selected invoice, MATCH the real
 * bank deposit to the invoice's Undeposited-Funds payment — the QBO-native fix.
 * The duplicate income line on the deposit becomes a link to the payment (plus a
 * fee line when a processor withheld one), so the invoice stays PAID, UF clears,
 * revenue is recognized once, and the deposit total — hence bank rec — is
 * unchanged. Nothing is voided.
 *
 * Per-invoice `actions` can opt a row into the legacy paths instead:
 *   "void"          — void the phantom payment(s) + the invoice (destroys A/R
 *                     history; only for genuinely junk CRM docs).
 *   "apply_deposit" — keep the invoice, repoint the deposit line to A/R as a
 *                     customer credit (depends on "auto-apply credits").
 *
 * Hard guards — every one re-checked server-side, client input never trusted:
 *   1. Admin/lead only.
 *   2. dry_run defaults TRUE — you must pass dry_run:false to write.
 *   3. Re-plans live from QBO (buildRemediationPreview); only invoices that are
 *      STILL `safe` are touched. A "review" invoice (real cash on a payment) is
 *      skipped unless allow_review:true is passed explicitly.
 *   4. Closed periods skipped (invoice dated on/before the QBO close date).
 *   5. Budget-chunked: returns remaining_ids; the UI re-invokes until done.
 * Idempotent-ish: an already-voided invoice/payment just reports as skipped.
 */
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
  const ids: string[] = Array.isArray(body.invoice_ids) ? body.invoice_ids.map(String) : [];
  const dryRun = body.dry_run !== false; // default TRUE — must opt in to write
  const allowReview = body.allow_review === true;
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || "") ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end || "") ? body.end : new Date().toISOString().slice(0, 10);

  if (!clientLinkId || ids.length === 0) {
    return NextResponse.json({ error: "client_link_id and invoice_ids required" }, { status: 400 });
  }

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !client.is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }
  const realm = (client as any).qbo_realm_id as string;

  let token: string;
  try {
    token = await getValidToken(clientLinkId, service as any);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "QBO auth failed" }, { status: 502 });
  }

  // Re-plan live from QBO — never trust the client's safety flags.
  const planned = await buildRemediationPreview(realm, token, start, end).catch((e) => {
    throw new Error(`Re-plan failed: ${e?.message || e}`);
  });
  const planById = new Map(planned.map((p) => [p.invoiceId, p]));
  const closingDate = await getCompanyClosingDate(realm, token).catch(() => null);

  const selected = ids.filter((id) => planById.has(id));
  // Per-invoice remediation choice (Mike 2026-07-17): "void" removes the dupe
  // invoice (deposit stays as revenue); "apply_deposit" KEEPS the invoice and
  // applies its matched bank deposit to it via A/R — for clients who actively
  // use invoicing. Default: void.
  const actions: Record<string, string> =
    body.actions && typeof body.actions === "object" ? body.actions : {};
  const summary = {
    dry_run: dryRun,
    requested: ids.length,
    would_match: 0,
    matched: 0,
    needs_fee_account: 0,
    would_void_invoices: 0,
    would_void_payments: 0,
    voided_invoices: 0,
    voided_payments: 0,
    would_apply_deposits: 0,
    applied_deposits: 0,
    skipped_closed: 0,
    skipped_review: 0,
    skipped_no_pair: 0,
    skipped_not_candidate: ids.length - selected.length,
    failed: 0,
    remaining_ids: [] as string[],
    details: [] as Array<{ invoiceId: string; doc: string | null; outcome: string; amount: number }>,
  };

  const memo = `SNAP CRM revenue remediation by ${(actor as any)?.full_name || "senior"} — matched bank deposits to the invoice payments (revenue recognized once)`;

  // Chart lookups: A/R for the legacy keep-invoice path, and a merchant/bank-fee
  // account (auto-detected) to absorb payment-vs-deposit gaps when matching.
  const wantsApplyDeposit = Object.values(actions).includes("apply_deposit");
  const wantsMatch = selected.some((id) => (actions[id] || "match") === "match");
  let arAccount: { id: string; name: string } | null = null;
  let feeAccount: { id: string; name: string } | null = null;
  if (wantsApplyDeposit || wantsMatch) {
    const all = await fetchAllAccounts(realm, token);
    if (wantsApplyDeposit) {
      arAccount = findArAccount(all);
      if (!arAccount) {
        return NextResponse.json({ error: "No active Accounts Receivable account in this QBO file — can't apply deposits to invoices" }, { status: 400 });
      }
    }
    if (wantsMatch) {
      // Explicit override wins; otherwise auto-detect. Null is fine — only rows
      // with an actual gap need it, and those report needs_fee_account.
      feeAccount = body.fee_account_id
        ? { id: String(body.fee_account_id), name: String(body.fee_account_name || "Fees") }
        : findFeeAccount(all);
    }
  }
  const snapshot = async (kind: string, id: string, entity: any): Promise<void> => {
    await service.from("audit_log").insert({
      event_type: "crm_invoice_remediation_snapshot",
      user_id: user.id,
      request_payload: { client_link_id: clientLinkId, kind, txn_id: id, entity } as any,
    } as any);
  };

  for (let i = 0; i < selected.length; i++) {
    if (Date.now() - startTime > BUDGET_MS || i >= MAX_PER_PASS) {
      summary.remaining_ids.push(...selected.slice(i));
      break;
    }
    const id = selected[i];
    const plan = planById.get(id)!;
    // DEFAULT = match (Mike 2026-07-28). Voiding a real invoice guts A/R
    // history; matching the deposit to the invoice's UF payment is what a
    // bookkeeper does in QBO. "void" / "apply_deposit" stay as explicit opt-ins.
    const requested = actions[id] || "match";
    const action = requested === "void" || requested === "apply_deposit" ? requested : "match";

    if (!plan.safe && !allowReview) {
      summary.skipped_review++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: "skipped: review (real cash on a payment)", amount: plan.total });
      continue;
    }
    if (closingDate && plan.date && plan.date <= closingDate) {
      summary.skipped_closed++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: `skipped: closed period (${closingDate})`, amount: plan.total });
      continue;
    }

    // ── MATCH PATH (default): deposit ↔ the invoice's UF payment ──
    // Nothing is voided: the invoice stays paid, the payment leaves Undeposited
    // Funds, revenue recognizes once, and the deposit total is unchanged.
    if (action === "match") {
      if (!plan.matchedDeposit) {
        summary.skipped_no_pair++;
        summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: "skipped: no confident deposit match — matching needs a pair", amount: plan.total });
        continue;
      }
      if (plan.payments.length === 0) {
        summary.skipped_no_pair++;
        summary.details.push({
          invoiceId: id,
          doc: plan.docNumber,
          outcome: "skipped: invoice has no payment to match (it's open) — the deposit is the cash; receive payment against it in QBO",
          amount: plan.total,
        });
        continue;
      }
      const out = await matchDepositToInvoicePayment({
        realm,
        token,
        invoiceId: id,
        payments: plan.payments.map((p) => ({ id: p.id, amount: p.amount })),
        deposit: { txn_id: plan.matchedDeposit.txn_id, account: plan.matchedDeposit.account, amount: plan.matchedDeposit.amount },
        feeAccount,
        dryRun,
        closingDate,
        snapshot,
      });
      if (out.outcome === "would_match") summary.would_match++;
      else if (out.outcome === "matched") summary.matched++;
      else if (out.outcome === "needs_fee_account") summary.needs_fee_account++;
      else if (out.outcome === "failed") summary.failed++;
      else if (out.outcome === "skipped_closed") summary.skipped_closed++;
      summary.details.push({
        invoiceId: id,
        doc: plan.docNumber,
        outcome: `${out.outcome}${out.detail ? `: ${out.detail}` : ""}`,
        amount: plan.total,
      });
      continue;
    }

    // ── KEEP-INVOICE PATH: void phantom payment(s), apply the matched deposit ──
    if (action === "apply_deposit") {
      if (!plan.matchedDeposit || !plan.customerId) {
        summary.skipped_no_pair++;
        summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: "skipped: no confident deposit match (or no customer) — keep-invoice path needs a pair", amount: plan.total });
        continue;
      }
      const out = await applyDepositToInvoice({
        realm,
        token,
        invoiceId: id,
        customerId: plan.customerId,
        deposit: { txn_id: plan.matchedDeposit.txn_id, account: plan.matchedDeposit.account, amount: plan.matchedDeposit.amount },
        phantomPaymentIds: plan.payments.map((p) => p.id),
        arAccountId: arAccount!.id,
        dryRun,
        closingDate,
        snapshot,
      });
      if (out.outcome === "would_apply") summary.would_apply_deposits++;
      else if (out.outcome === "applied") { summary.applied_deposits++; summary.voided_payments += plan.payments.length; }
      else if (out.outcome === "failed") summary.failed++;
      else if (out.outcome === "skipped_closed") summary.skipped_closed++;
      summary.details.push({
        invoiceId: id,
        doc: plan.docNumber,
        outcome: out.outcome === "would_apply"
          ? `would keep invoice + apply deposit ${plan.matchedDeposit.txn_id} (${plan.matchedDeposit.account} $${plan.matchedDeposit.amount})`
          : `${out.outcome}${out.detail ? `: ${out.detail}` : ""}`,
        amount: plan.total,
      });
      continue;
    }

    // ── VOID PATH (default) ──
    if (dryRun) {
      summary.would_void_invoices++;
      summary.would_void_payments += plan.payments.length;
      summary.details.push({
        invoiceId: id,
        doc: plan.docNumber,
        outcome: plan.action === "void_invoice_only"
          ? "would void invoice (no payment)"
          : `would void ${plan.payments.length} payment(s) + invoice`,
        amount: plan.total,
      });
      continue;
    }

    // ── WRITE ── void payment(s) first (unlinks), then the invoice.
    try {
      for (const p of plan.payments) {
        await voidPayment(realm, token, p.id, "Payment");
        summary.voided_payments++;
      }
      await voidInvoice(realm, token, id);
      summary.voided_invoices++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: "voided invoice + payment(s)", amount: plan.total });
    } catch (err: any) {
      summary.failed++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: `FAILED: ${String(err?.message || err).slice(0, 160)}`, amount: plan.total });
    }
  }

  if (!dryRun) {
    try {
      await service.from("audit_log").insert({
        event_type: "crm_invoice_remediation_apply",
        user_id: user.id,
        request_payload: {
          client_link_id: clientLinkId,
          client_name: (client as any).client_name,
          window: { start, end },
          memo,
          ...summary,
          details: summary.details.slice(0, 60),
          remaining: summary.remaining_ids.length,
          remaining_ids: undefined,
        } as any,
      } as any);
    } catch (e: any) {
      console.warn(`[crm-invoice-remediation] audit insert failed: ${e?.message}`);
    }
  }

  return NextResponse.json(summary);
}
