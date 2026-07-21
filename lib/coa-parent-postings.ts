/**
 * Parent-account direct postings
 * ------------------------------
 * QuickBooks lets you post a transaction straight to a PARENT account (one that
 * already has sub-accounts). It isn't blocked and the money isn't lost — QBO
 * reports it on a synthetic "[Parent] – Other" line. But it's bad books: on a
 * collapsed statement the "– Other" folds into the parent total and disappears,
 * and it almost always means the txn belongs on a specific sub-account.
 *
 * The COA drift audit reads chart STRUCTURE, not where transactions sit, so it
 * can't see this. We detect it from the P&L summary instead: flattenRows
 * already splits out a parent's OWN amount (rollup − children) as its own line
 * item (see lib/qbo-reports.ts — the "Direct Field Labor – Painting $58,470 on
 * the parent" case). So a line item whose account is itself a parent, with a
 * nonzero own amount, IS a pile of direct postings on that parent.
 *
 * The fix is a reclass of those lines down to the correct sub-account (a human
 * picks which child — judgment — but the move is then deterministic).
 */

export interface ParentPostingChild {
  id: string;
  name: string;
}

export interface ParentPosting {
  parent_id: string;
  parent_name: string;
  /** P&L section the parent sits in (Income / COGS / Expense…). */
  group: string;
  /** The parent's OWN amount — the direct postings, net of sub-accounts. */
  amount: number;
  /** Active sub-accounts = the candidate targets to move the postings onto. */
  children: ParentPostingChild[];
}

interface DriftLikeAccount {
  Id: string;
  Name: string;
  Active?: boolean;
  ParentRef?: { value: string } | null;
}

interface PlLineItemLike {
  label: string;
  amount: number;
  group: string;
  account_id: string | null;
}

/**
 * PURE detection. `accounts` = live chart (to know which ids are parents +
 * their children); `plLineItems` = fetchProfitAndLoss(...).lineItems, which
 * already carries a parent's own (direct) amount as a separate line.
 */
export function detectParentPostings(
  accounts: DriftLikeAccount[],
  plLineItems: PlLineItemLike[]
): ParentPosting[] {
  // An account is a PARENT if some active account names it as its parent.
  const childrenByParent = new Map<string, ParentPostingChild[]>();
  for (const a of accounts) {
    if (a.Active === false) continue;
    const pid = a.ParentRef?.value ? String(a.ParentRef.value) : null;
    if (!pid) continue;
    const list = childrenByParent.get(pid) || [];
    list.push({ id: String(a.Id), name: a.Name });
    childrenByParent.set(pid, list);
  }

  // Sum own amounts per parent id (a parent should surface once, but be safe).
  const amountByParent = new Map<string, { name: string; group: string; amount: number }>();
  for (const li of plLineItems) {
    if (!li.account_id) continue;
    const pid = String(li.account_id);
    if (!childrenByParent.has(pid)) continue; // only accounts that ARE parents
    const cur = amountByParent.get(pid) || { name: li.label, group: li.group, amount: 0 };
    cur.amount = Math.round((cur.amount + (Number(li.amount) || 0)) * 100) / 100;
    amountByParent.set(pid, cur);
  }

  const out: ParentPosting[] = [];
  for (const [pid, v] of amountByParent) {
    if (Math.abs(v.amount) < 0.005) continue; // pure rollup, no direct postings
    out.push({
      parent_id: pid,
      parent_name: v.name,
      group: v.group,
      amount: v.amount,
      children: (childrenByParent.get(pid) || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}
