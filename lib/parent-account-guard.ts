/**
 * HARD RULE: never post a transaction to a parent account.
 *
 * A parent account is a heading, not a bucket. QBO will happily accept a
 * posting straight onto it, and the result is a chart where the parent's total
 * is "its own direct postings PLUS the sum of its children" — so the P&L no
 * longer reconciles against the detail beneath it, the sub-accounts understate
 * the real spend, and the statement silently disagrees with the drill-down.
 * It was one of the systemic findings in the JP methodology audit
 * ("parent-postings"), and the statement builder has already had to work around
 * parent balances once (lib/pl-hierarchy.ts).
 *
 * This is enforced as an invariant rather than a preference: every automated
 * write path — reclass execution, monthly/daily recon auto-execute, bank rules,
 * the COA cleanup executor — routes through here, and a parent target is
 * demoted to human review rather than posted.
 *
 * Parenthood is derived from live QBO, not from master_coa: what matters is
 * whether THIS client's chart has children hanging off the account right now.
 */

export interface ParentishAccount {
  Id?: string;
  id?: string;
  Name?: string;
  name?: string;
  ParentRef?: { value?: string | null } | null;
  parent_account_id?: string | null;
  SubAccount?: boolean | null;
  Active?: boolean | null;
}

const idOf = (a: ParentishAccount) => String(a.Id ?? a.id ?? "");
const parentIdOf = (a: ParentishAccount) =>
  String(a.ParentRef?.value ?? a.parent_account_id ?? "") || null;

/**
 * Ids of accounts that have at least one child, i.e. the accounts nothing may
 * be posted to.
 *
 * Inactive children still count. An inactive sub-account keeps its historical
 * postings, so its parent remains a heading with detail underneath it — posting
 * to that parent still splits the account's history in two.
 */
export function buildParentAccountIds(accounts: ParentishAccount[]): Set<string> {
  const parents = new Set<string>();
  for (const a of accounts) {
    const pid = parentIdOf(a);
    if (pid) parents.add(pid);
  }
  return parents;
}

/** Names of parent accounts, normalized lower-case, for name-keyed call sites. */
export function buildParentAccountNames(accounts: ParentishAccount[]): Set<string> {
  const parentIds = buildParentAccountIds(accounts);
  const names = new Set<string>();
  for (const a of accounts) {
    if (parentIds.has(idOf(a))) {
      const n = (a.Name ?? a.name ?? "").trim().toLowerCase();
      if (n) {
        names.add(n);
        // QBO fully-qualified names arrive as "Parent:Child" — index the leaf
        // too so a call site holding either form gets a hit.
        const leaf = n.split(":").pop()!.trim();
        if (leaf) names.add(leaf);
      }
    }
  }
  return names;
}

export function isParentAccountId(
  accountId: string | null | undefined,
  parentIds: Set<string>
): boolean {
  if (!accountId) return false;
  return parentIds.has(String(accountId));
}

export function isParentAccountName(
  accountName: string | null | undefined,
  parentNames: Set<string>
): boolean {
  if (!accountName) return false;
  const n = accountName.trim().toLowerCase();
  if (parentNames.has(n)) return true;
  const leaf = n.split(":").pop()!.trim();
  return !!leaf && parentNames.has(leaf);
}

/** The single message used everywhere, so bookkeepers see one consistent reason. */
export function parentAccountBlockReason(accountName: string): string {
  return (
    `"${accountName}" is a parent account — transactions must never post to a parent, ` +
    `only to one of its sub-accounts. Pick the specific sub-account instead.`
  );
}

/** Minimal shape of a pending reclassification row, as written to the DB. */
interface GuardableRow {
  to_account_id?: string | null;
  to_account_name?: string | null;
  decision?: string | null;
  status?: string | null;
  skip_reason?: string | null;
  ai_reasoning?: string | null;
}

/**
 * Enforce the no-parent-postings rule at the WRITE BOUNDARY.
 *
 * Applied to whole batches immediately before insert rather than inside each
 * row builder, because targets arrive from six different places (AI, knowledge
 * base, bank-rule cache, bookkeeper override, client answer, transfer pre-pass)
 * and three of them resolve by NAME. One choke point at the boundary is the only
 * version of this that can't be bypassed by adding a seventh source later.
 *
 * A parent target is demoted to `needs_review` with an explanatory reason —
 * never dropped, never silently retargeted. Mutates in place and returns the
 * number of rows changed so the caller can log it.
 */
export function enforceNoParentPostings(
  rows: GuardableRow[],
  parentIds: Set<string>,
  parentNames: Set<string>
): number {
  if (parentIds.size === 0 && parentNames.size === 0) return 0;
  let blocked = 0;

  for (const row of rows) {
    const hitsParent =
      isParentAccountId(row.to_account_id, parentIds) ||
      isParentAccountName(row.to_account_name, parentNames);
    if (!hitsParent) continue;

    // Rows that were already going to a human, or already skipped for a real
    // reason (closed period, reconciled), don't need re-labelling — nothing is
    // going to be posted from them anyway.
    if (row.decision === "needs_review" || row.decision === "flagged" || row.decision === "ask_client") continue;
    if (row.status === "skipped" && row.skip_reason && row.skip_reason !== "already_correct") continue;

    row.decision = "needs_review";
    row.status = "pending";
    row.skip_reason = null;
    row.ai_reasoning =
      `${parentAccountBlockReason(row.to_account_name || "the suggested account")} ` +
      `Needs a human to pick the right sub-account. ` +
      `Original reasoning: ${row.ai_reasoning || "n/a"}`;
    blocked++;
  }
  return blocked;
}
