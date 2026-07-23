/**
 * P&L parent/sub-account hierarchy — mirror QBO's statement structure.
 *
 * QBO's ProfitAndLoss shows a parent account with its sub-accounts nested
 * (parent header, each sub line, "Total <parent>"). SNAP's report parser
 * (lib/qbo-reports.ts flattenRows) flattens that to leaf amounts + a synthesized
 * parent "own remainder" and drops the nesting. This rebuilds the hierarchy from
 * the CHART OF ACCOUNTS (which carries ParentRef / FullyQualifiedName) and hangs
 * the report amounts (matched by account id, name fallback) on it, then computes
 * parent rollups so both the internal and portal P&L can render QBO-style.
 *
 * Pure + testable — no I/O.
 */

export interface PLLineItem {
  label: string;
  amount: number;
  group: string; // section: "Income" | "COGS" | "Expenses" | "OtherIncome" | "OtherExpense" | …
  account_id: string | null;
}

export interface PLAccountLite {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  AccountType?: string;
  Classification?: string; // "Revenue" | "Expense" | …
  Active?: boolean;
  ParentRef?: { value: string } | null;
}

export type PLSectionKey = "income" | "cogs" | "expenses" | "other_income" | "other_expense";

export interface PLHierRow {
  accountId: string | null;
  /** Full leaf name to display (leaf segment, not the colon path). */
  name: string;
  depth: number;
  /** The account's own posted amount (excludes sub-accounts). */
  own: number;
  /** own + all descendants (what QBO shows on the parent's "Total" line). */
  total: number;
  hasChildren: boolean;
  /** true = the "Total <parent>" summary row under a parent with children. */
  isTotalRow: boolean;
}

export interface PLHierSection {
  key: PLSectionKey;
  title: string;
  rows: PLHierRow[];
  total: number;
}

export interface PLHierarchy {
  sections: PLHierSection[];
  totalIncome: number;
  totalCogs: number;
  totalExpenses: number; // operating expenses (excludes COGS)
  grossProfit: number;
  netProfit: number;
}

const SECTION_TITLES: Record<PLSectionKey, string> = {
  income: "Income",
  cogs: "Cost of Goods Sold",
  expenses: "Operating Expenses",
  other_income: "Other Income",
  other_expense: "Other Expenses",
};
const SECTION_ORDER: PLSectionKey[] = ["income", "cogs", "expenses", "other_income", "other_expense"];

function norm(s: string | undefined | null): string {
  return String(s || "").trim().toLowerCase();
}
function isCogsType(t: string): boolean {
  return /cost of goods sold|\bcogs\b/i.test(t || "");
}
function sectionFor(acct: PLAccountLite): PLSectionKey {
  const cls = norm(acct.Classification);
  const type = acct.AccountType || "";
  if (cls === "revenue") return /other income/i.test(type) ? "other_income" : "income";
  if (cls === "expense") {
    if (isCogsType(type)) return "cogs";
    if (/other expense/i.test(type)) return "other_expense";
    return "expenses";
  }
  // Fallback by type when Classification missing.
  if (/income/i.test(type)) return "income";
  if (isCogsType(type)) return "cogs";
  return "expenses";
}

interface Node {
  acct: PLAccountLite | null; // null = synthetic (report line with no matching account)
  accountId: string | null;
  name: string; // leaf display name
  section: PLSectionKey;
  own: number;
  children: Node[];
  total: number; // filled in rollup
}

/**
 * Build the P&L hierarchy. `lineItems` supply amounts (from the report);
 * `accounts` supply structure (parent/child). showZeros keeps accounts with a
 * zero rollup; otherwise they're pruned.
 */
export function buildPLHierarchy(
  lineItems: PLLineItem[],
  accounts: PLAccountLite[],
  opts: { showZeros?: boolean } = {}
): PLHierarchy {
  const showZeros = !!opts.showZeros;

  // Amount lookups from the report.
  const byId = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const li of lineItems || []) {
    if (li.account_id) byId.set(li.account_id, (byId.get(li.account_id) || 0) + li.amount);
    const key = norm(li.label);
    if (key) byName.set(key, (byName.get(key) || 0) + li.amount);
  }

  const ownAmount = (a: PLAccountLite): number => {
    if (byId.has(a.Id)) return byId.get(a.Id)!;
    const leaf = (a.FullyQualifiedName || a.Name || "").split(":").pop() || a.Name;
    if (byName.has(norm(a.Name))) return byName.get(norm(a.Name))!;
    if (byName.has(norm(leaf))) return byName.get(norm(leaf))!;
    return 0;
  };

  // Only P&L accounts (Revenue/Expense) participate. Include inactive accounts
  // that still carry a reported amount (deleted-with-balance).
  const plAccounts = (accounts || []).filter((a) => {
    const cls = norm(a.Classification);
    const isPL = cls === "revenue" || cls === "expense";
    if (!isPL) return false;
    return a.Active !== false || byId.has(a.Id);
  });
  const accountById = new Map(plAccounts.map((a) => [a.Id, a]));

  // Build nodes + parent/child links.
  const nodeById = new Map<string, Node>();
  for (const a of plAccounts) {
    nodeById.set(a.Id, {
      acct: a,
      accountId: a.Id,
      name: (a.FullyQualifiedName || a.Name || "").split(":").pop() || a.Name,
      section: sectionFor(a),
      own: ownAmount(a),
      children: [],
      total: 0,
    });
  }
  const roots: Node[] = [];
  for (const a of plAccounts) {
    const node = nodeById.get(a.Id)!;
    const parentId = a.ParentRef?.value;
    if (parentId && nodeById.has(parentId)) {
      nodeById.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Report lines with no matching account (deleted / id mismatch) → synthetic
  // root leaves in the right section so nothing is silently dropped.
  const matchedNames = new Set<string>();
  for (const a of plAccounts) {
    matchedNames.add(norm(a.Name));
    matchedNames.add(norm((a.FullyQualifiedName || a.Name).split(":").pop() || a.Name));
  }
  for (const li of lineItems || []) {
    const hasAccount = li.account_id && accountById.has(li.account_id);
    if (hasAccount) continue;
    if (matchedNames.has(norm(li.label))) continue; // matched by name already
    if (Math.abs(li.amount) < 0.005 && !showZeros) continue;
    const g = norm(li.group);
    const section: PLSectionKey =
      g === "income" ? "income"
      : g === "cogs" ? "cogs"
      : g === "otherincome" ? "other_income"
      : g === "otherexpense" ? "other_expense"
      : "expenses";
    roots.push({
      acct: null, accountId: li.account_id, name: li.label, section,
      own: li.amount, children: [], total: li.amount,
    });
  }

  // Roll up totals (post-order).
  const rollup = (n: Node): number => {
    let t = n.own;
    for (const c of n.children) t += rollup(c);
    n.total = t;
    return t;
  };
  for (const r of roots) rollup(r);

  // Emit depth-annotated rows per section, pruning zero rollups unless showZeros.
  const sections: PLHierSection[] = SECTION_ORDER.map((key) => ({
    key, title: SECTION_TITLES[key], rows: [] as PLHierRow[], total: 0,
  }));
  const sectionByKey = new Map(sections.map((s) => [s.key, s]));

  const nonZero = (n: Node): boolean => Math.abs(n.total) >= 0.005 || n.children.some(nonZero);

  const emit = (n: Node, depth: number, out: PLHierRow[]) => {
    if (!showZeros && !nonZero(n)) return;
    const kids = [...n.children].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    const hasChildren = kids.length > 0;
    out.push({
      accountId: n.accountId, name: n.name, depth,
      own: n.own, total: n.total, hasChildren, isTotalRow: false,
    });
    for (const c of kids) emit(c, depth + 1, out);
    if (hasChildren) {
      out.push({
        accountId: n.accountId, name: `Total ${n.name}`, depth,
        own: 0, total: n.total, hasChildren: false, isTotalRow: true,
      });
    }
  };

  for (const r of roots) {
    const s = sectionByKey.get(r.section)!;
    emit(r, 0, s.rows);
  }
  // Sort top-level groupings within a section by magnitude (stable-ish): we
  // emitted roots in account order; re-sort section rows is complex with
  // nesting, so leave insertion order (roots already reasonable). Compute totals.
  for (const s of sections) {
    s.total = roots.filter((r) => r.section === s.key).reduce((sum, r) => sum + r.total, 0);
  }

  const totalIncome = (sectionByKey.get("income")!.total) + (sectionByKey.get("other_income")!.total);
  const totalCogs = sectionByKey.get("cogs")!.total;
  const totalExpenses = sectionByKey.get("expenses")!.total;
  const totalOtherExp = sectionByKey.get("other_expense")!.total;
  const grossProfit = sectionByKey.get("income")!.total - totalCogs;
  const netProfit = totalIncome - totalCogs - totalExpenses - totalOtherExp;

  return {
    sections: sections.filter((s) => s.rows.length > 0),
    totalIncome,
    totalCogs,
    totalExpenses,
    grossProfit,
    netProfit,
  };
}
