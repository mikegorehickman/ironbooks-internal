/**
 * Turn stored UF audit items into a WORKLIST — what to do with each payment.
 *
 * WHY. The first cut of the fleet page reported four numbers per client (balance,
 * orphan count, orphaned $, clears-on-deposit) and linked out. Mike, correctly:
 * "this tool is assuming we have all the information, but we really need the tool
 * to do the matching and recommending."
 *
 * The matching already exists and is already persisted. `scanUfAudit` runs
 * duplicate detection and `matchOrphansToDeposits`, and every field lands in
 * `uf_audit_items`: the deposit an orphan probably belongs to, the match kind
 * (exact / bundled combination / CA tax-adjusted), a confidence, and the group of
 * sibling payments that share one bundled deposit. The report threw all of it
 * away by aggregating. This reads it back and states the action.
 *
 * Pure — the caller supplies the rows. No QBO, no DB.
 */

export type UfAction = "void_duplicate" | "create_deposit" | "apply_to_invoice" | "ask_client";

/** One stored row from `uf_audit_items` (only the fields this needs). */
export interface UfItemRow {
  id: string;
  scan_id: string;
  qbo_payment_id: string;
  qbo_payment_txn_type: string | null;
  payment_date: string | null;
  payment_amount: number | null;
  customer_name: string | null;
  payment_memo: string | null;
  payment_ref_num: string | null;
  applied_invoice_ids: string[] | null;
  classification: string | null;
  suspected_duplicate: boolean | null;
  duplicate_of_payment_id: string | null;
  duplicate_reason: string | null;
  probable_deposit_id: string | null;
  probable_deposit_date: string | null;
  probable_deposit_amount: number | null;
  probable_deposit_bank: string | null;
  probable_match_kind: string | null;
  probable_match_confidence: number | null;
  probable_match_note: string | null;
  probable_match_group: string[] | null;
  resolution: string | null;
}

export interface UfWorkItem {
  id: string;
  paymentId: string;
  date: string;
  customer: string;
  amount: number;
  memo: string;
  action: UfAction;
  /** One line a bookkeeper can act on without opening QBO first. */
  recommendation: string;
  /** 0-1 where the matcher gave one. Null = no match to be confident about. */
  confidence: number | null;
  /** Already resolved in a previous pass — shown but not counted as work. */
  done: boolean;
}

export const UF_ACTION_LABEL: Record<UfAction, string> = {
  void_duplicate: "Void the duplicate",
  create_deposit: "Create the Bank Deposit",
  apply_to_invoice: "Apply to the open invoice",
  ask_client: "Ask the client",
};

/**
 * Decide the action for one stored payment.
 *
 * Order matters. A duplicate is checked FIRST: a duplicated payment can also
 * tie to a deposit by amount, and depositing it would bank the same money twice.
 * `ask_client` is last and deliberately means "the matcher found nothing" — not
 * "probably fine".
 */
export function recommendForItem(r: UfItemRow): UfWorkItem {
  const amount = Math.abs(Number(r.payment_amount) || 0);
  const customer = r.customer_name || "(no customer)";
  const money = (n: number) =>
    `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const base = {
    id: r.id,
    paymentId: r.qbo_payment_id,
    date: r.payment_date || "",
    customer,
    amount,
    memo: (r.payment_memo || "").slice(0, 80),
    // "skipped" is what the scanner writes for an already-matched payment;
    // anything not pending/skipped is a resolution a human already chose.
    done: !!r.resolution && r.resolution !== "pending",
  };

  if (r.suspected_duplicate) {
    return {
      ...base,
      action: "void_duplicate",
      confidence: null,
      recommendation:
        `Duplicate of payment ${r.duplicate_of_payment_id || "(unknown)"}` +
        (r.duplicate_reason ? ` — ${r.duplicate_reason}` : "") +
        `. Void this one; do not deposit it, or the same money banks twice.`,
    };
  }

  if (r.probable_deposit_id) {
    const kind =
      r.probable_match_kind === "combination" || r.probable_match_kind === "tax_combination"
        ? `bundled with ${Math.max((r.probable_match_group || []).length - 1, 1)} other payment(s) into one deposit`
        : r.probable_match_kind === "tax_adjusted"
        ? "amount ties after sales tax"
        : "exact amount match";
    return {
      ...base,
      action: "create_deposit",
      confidence: r.probable_match_confidence ?? null,
      recommendation:
        `The money landed: deposit ${money(Number(r.probable_deposit_amount) || 0)} on ` +
        `${r.probable_deposit_date || "?"}${r.probable_deposit_bank ? ` into ${r.probable_deposit_bank}` : ""} ` +
        `(${kind}). Record the Bank Deposit for this payment to clear it out of UF.` +
        (r.probable_match_note ? ` ${r.probable_match_note}` : ""),
    };
  }

  // Applied to an invoice but never deposited — revenue is right, the cash leg
  // is missing. Distinct from the no-invoice case because the question differs.
  if ((r.applied_invoice_ids || []).length > 0) {
    return {
      ...base,
      action: "ask_client",
      confidence: null,
      recommendation:
        `Applied to an invoice but no matching bank deposit found. Ask the client which account ` +
        `this ${money(amount)} was deposited into — or whether it was ever actually received.`,
    };
  }

  return {
    ...base,
    action: "ask_client",
    confidence: null,
    recommendation:
      `No bank deposit found for this ${money(amount)} and it isn't applied to an invoice. ` +
      `Ask the client whether it was deposited elsewhere, refunded, or entered in error.`,
  };
}

export interface UfClientWork {
  clientLinkId: string;
  items: UfWorkItem[];
  /** Open work only — resolved items are excluded from every total. */
  byAction: Record<UfAction, { count: number; amount: number }>;
  openAmount: number;
  openCount: number;
}

const emptyByAction = (): Record<UfAction, { count: number; amount: number }> => ({
  void_duplicate: { count: 0, amount: 0 },
  create_deposit: { count: 0, amount: 0 },
  apply_to_invoice: { count: 0, amount: 0 },
  ask_client: { count: 0, amount: 0 },
});

/** Group stored items into per-client worklists. Orphans only — a matched
 *  payment has a deposit behind it and isn't work. */
export function buildUfWorklists(
  rows: UfItemRow[],
  scanToClient: Map<string, string>
): Map<string, UfClientWork> {
  const out = new Map<string, UfClientWork>();
  for (const r of rows || []) {
    if (r.classification === "matched") continue;
    const clientLinkId = scanToClient.get(r.scan_id);
    if (!clientLinkId) continue;
    const item = recommendForItem(r);
    const w =
      out.get(clientLinkId) ||
      ({ clientLinkId, items: [], byAction: emptyByAction(), openAmount: 0, openCount: 0 } as UfClientWork);
    w.items.push(item);
    if (!item.done) {
      w.byAction[item.action].count++;
      w.byAction[item.action].amount = round2(w.byAction[item.action].amount + item.amount);
      w.openAmount = round2(w.openAmount + item.amount);
      w.openCount++;
    }
    out.set(clientLinkId, w);
  }
  // Biggest money first inside each client — that is the work order.
  for (const w of out.values()) w.items.sort((a, b) => b.amount - a.amount);
  return out;
}

export function sumByAction(worklists: Iterable<UfClientWork>) {
  const total = emptyByAction();
  for (const w of worklists) {
    for (const k of Object.keys(total) as UfAction[]) {
      total[k].count += w.byAction[k].count;
      total[k].amount = round2(total[k].amount + w.byAction[k].amount);
    }
  }
  return total;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
