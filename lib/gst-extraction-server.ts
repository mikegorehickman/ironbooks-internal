/**
 * GST/HST extraction — the QBO-touching layer on top of the pure planner
 * (lib/gst-extraction.ts). Three jobs:
 *
 *  1. resolveExtractionContext — ONE shared resolver used by BOTH the preview
 *     and the apply endpoints (D14 lesson: shared module or the two drift):
 *     pulls the cash P&L detail + summary, builds the normalized master-COA
 *     kind map + heuristic fallbacks, returns the plan.
 *  2. ensureTaxAccounts — find-or-create the client's tax accounts in QBO
 *     (GST/HST Payable etc., QST names for Quebec).
 *  3. The writers — split Deposit lines (income) and expense-family lines
 *     (ITCs) with the same full-entity-echo update pattern the reclass
 *     executor uses. Line MATCHING is pure + exported for fixtures; a line
 *     that can't be matched exactly (account + amount) means a human changed
 *     the books since the plan — the whole transaction is skipped, never
 *     guessed. Totals never change.
 */

import { qboRequest, fetchAllAccounts, createAccount, type QBOAccount } from "./qbo";
import { fetchPLDetailAll, fetchProfitAndLoss } from "./qbo-reports";
import { incomeAccountNamesFromSummary } from "./crm-invoice-revenue";
import {
  buildExtractionPlan,
  classifyAccountKind,
  normalizeAccountKey,
  taxAccountNamesFor,
  GST_EXTRACTION_MEMO,
  type ExtractionPlan,
  type GstInputKind,
  type DepositLinePlan,
  type ExpenseLinePlan,
} from "./gst-extraction";

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

// ── 1. Shared context resolver ───────────────────────────────────────────────

export interface ExtractionContext {
  plan: ExtractionPlan;
  heuristicKinds: Array<{ account: string; kind: GstInputKind }>;
}

export async function resolveExtractionContext(
  service: any,
  client: { qbo_realm_id: string; state_province: string | null; industry: string | null },
  token: string,
  start: string,
  end: string,
  /** Raw vendor names to exclude from ITC splitting (normalized internally). */
  excludeVendors?: string[]
): Promise<ExtractionContext | { error: string }> {
  const province = (client.state_province || "").toUpperCase();
  const industry = client.industry || "painters";

  let { data: coaRows } = await service
    .from("master_coa")
    .select("account_name, gst_input_kind")
    .eq("jurisdiction", "CA")
    .eq("industry", industry)
    .not("gst_input_kind", "is", null);
  if (!coaRows || coaRows.length === 0) {
    ({ data: coaRows } = await service
      .from("master_coa")
      .select("account_name, gst_input_kind")
      .eq("jurisdiction", "CA")
      .eq("industry", "painters")
      .not("gst_input_kind", "is", null));
  }
  const kindByAccount = new Map<string, GstInputKind>(
    ((coaRows as any[]) || []).map((r) => [
      normalizeAccountKey(String(r.account_name)),
      r.gst_input_kind as GstInputKind,
    ])
  );
  if (kindByAccount.size === 0) {
    return { error: "master_coa has no gst_input_kind data — run migration 130 first" };
  }

  const [plDetail, plSummary] = await Promise.all([
    fetchPLDetailAll(client.qbo_realm_id, token, start, end, "Cash"),
    fetchProfitAndLoss(client.qbo_realm_id, token, start, end, "Cash"),
  ]);
  const incomeAccounts = incomeAccountNamesFromSummary(plSummary);

  const heuristicKinds: Array<{ account: string; kind: GstInputKind }> = [];
  for (const row of plDetail) {
    const key = normalizeAccountKey(row.account);
    if (!key || kindByAccount.has(key)) continue;
    const kind = classifyAccountKind(row.account);
    if (kind) {
      kindByAccount.set(key, kind);
      heuristicKinds.push({ account: row.account, kind });
    }
  }
  heuristicKinds.sort((a, b) => a.account.localeCompare(b.account));

  const plan = buildExtractionPlan(plDetail, province, incomeAccounts, kindByAccount, {
    excludeVendors: excludeVendors?.length
      ? new Set(excludeVendors.map((v) => normalizeAccountKey(v)).filter(Boolean))
      : undefined,
  });
  if (!plan) {
    return { error: `Province "${province || "(none)"}" isn't a recognized Canadian province — set it on the client profile first` };
  }
  return { plan, heuristicKinds };
}

// ── 2. Tax accounts in the client's QBO ──────────────────────────────────────

export interface TaxAccountIds {
  payable: { id: string; name: string };
  recoverable: { id: string; name: string };
  pstPayable: { id: string; name: string } | null;
  created: string[]; // names created this run (empty on dry-run finds)
}

/**
 * QBO's built-in sales-tax accounts are AGENCY-LINKED (AccountSubType
 * GlobalTaxPayable / GlobalTaxSuspense) and the API REJECTS direct postings to
 * them — proven live on Maple City: deposit update → 400 "Tax Liability
 * Account". They also own the name "GST/HST Payable", so we can neither post
 * to them nor create a same-named account.
 */
export function isAgencyLinkedAccount(a: { AccountSubType?: string | null }): boolean {
  return /globaltax/i.test(String(a?.AccountSubType || ""));
}

export type TaxAccountTarget =
  | { action: "use"; id: string; name: string }
  | { action: "create"; name: string };

/**
 * Pick the postable account for a primary/fallback name pair. Pure.
 *   - primary name exists and is postable → use it
 *   - primary name owned by an agency-linked account → fallback name
 *     (use if postable, else create fallback)
 *   - nothing exists → create primary
 */
export function pickTaxAccountTarget(
  accounts: Array<{ Id: string; Name: string; Active?: boolean; AccountSubType?: string }>,
  primaryName: string,
  fallbackName: string
): TaxAccountTarget {
  const byName = (name: string) =>
    accounts.filter((a) => a.Active !== false && normalizeAccountKey(a.Name) === normalizeAccountKey(name));

  const primaries = byName(primaryName);
  const postablePrimary = primaries.find((a) => !isAgencyLinkedAccount(a));
  if (postablePrimary) return { action: "use", id: postablePrimary.Id, name: postablePrimary.Name };

  if (primaries.length > 0) {
    // Name owned by an agency-linked account → fall back.
    const fallbacks = byName(fallbackName);
    const postableFallback = fallbacks.find((a) => !isAgencyLinkedAccount(a));
    if (postableFallback) return { action: "use", id: postableFallback.Id, name: postableFallback.Name };
    return { action: "create", name: fallbackName };
  }
  return { action: "create", name: primaryName };
}

/** Fallback ("Collected") names when QBO's agency account owns the primary. */
export function taxFallbackNamesFor(province: string | null | undefined): {
  payable: string;
  recoverable: string;
  pstPayable: string;
} {
  const qc = (province || "").toUpperCase() === "QC";
  return {
    payable: qc ? "GST/QST Collected" : "GST/HST Collected",
    // The recoverable asset is OURS by construction — but a name collision
    // with something unpostable is still possible; suffix keeps it distinct.
    recoverable: qc ? "GST/QST Recoverable (ITRs) - SNAP" : "GST/HST Recoverable (ITCs) - SNAP",
    pstPayable: "PST Collected",
  };
}

/**
 * Find (normalized-name match, agency-linked excluded) or create the tax
 * accounts. When dryRun, never creates — reported as "would create: X".
 * A duplicate-name create error (name reserved by an inactive account) falls
 * back to the Collected name.
 */
export async function ensureTaxAccounts(
  realm: string,
  token: string,
  province: string,
  needPst: boolean,
  dryRun: boolean
): Promise<TaxAccountIds> {
  const names = taxAccountNamesFor(province);
  const fallbacks = taxFallbackNamesFor(province);
  const all = await fetchAllAccounts(realm, token);

  const created: string[] = [];
  const resolve = async (
    primaryName: string,
    fallbackName: string,
    accountType: string,
    accountSubType: string
  ): Promise<{ id: string; name: string }> => {
    const target = pickTaxAccountTarget(all as any[], primaryName, fallbackName);
    if (target.action === "use") return { id: target.id, name: target.name };
    if (dryRun) {
      created.push(`would create: ${target.name}`);
      return { id: "", name: target.name };
    }
    const make = async (name: string) =>
      createAccount(realm, token, {
        name,
        accountType,
        accountSubType,
        description: `Created by SNAP GST/HST extraction — ${GST_EXTRACTION_MEMO}`,
      });
    try {
      const acc = await make(target.name);
      created.push(acc.Name);
      return { id: acc.Id, name: acc.Name };
    } catch (e: any) {
      // Name reserved (e.g. inactive holder, or an agency account we couldn't
      // see) → one fallback attempt with the Collected name.
      if (target.name !== fallbackName) {
        const acc = await make(fallbackName);
        created.push(acc.Name);
        return { id: acc.Id, name: acc.Name };
      }
      throw e;
    }
  };

  const payable = await resolve(names.payable, fallbacks.payable, "Other Current Liability", "OtherCurrentLiabilities");
  const recoverable = await resolve(names.recoverable, fallbacks.recoverable, "Other Current Asset", "OtherCurrentAssets");
  const pstPayable = needPst
    ? await resolve(names.pstPayable, fallbacks.pstPayable, "Other Current Liability", "OtherCurrentLiabilities")
    : null;
  return { payable, recoverable, pstPayable, created };
}

// ── 3. Pure line matching + mutation (fixture-tested) ───────────────────────

export interface DepositMatchResult {
  ok: boolean;
  reason?: string;
  lines?: any[];
}

/**
 * Apply planned income splits to a Deposit's line array. Pure. Each planned
 * row must match exactly ONE unconsumed DepositLineDetail line by income
 * account id + gross amount; the matched line's Amount drops to net and new
 * tax lines are appended. Any unmatched plan row → { ok:false } (whole txn
 * skipped by the caller — a human changed the books since the plan).
 */
export function applyDepositPlanToLines(
  entityLines: any[],
  plans: Array<{ accountId: string; gross: number; net: number; gstHst: number; pst: number }>,
  payableId: string,
  pstPayableId: string | null
): DepositMatchResult {
  const lines = entityLines.map((l) => ({ ...l }));
  const consumed = new Set<number>();
  let addGstHst = 0;
  let addPst = 0;

  for (const p of plans) {
    let matched = -1;
    for (let i = 0; i < lines.length; i++) {
      if (consumed.has(i)) continue;
      const l = lines[i];
      if (l.DetailType !== "DepositLineDetail") continue;
      const ref = l.DepositLineDetail?.AccountRef?.value;
      if (String(ref) !== String(p.accountId)) continue;
      if (r2(Number(l.Amount)) !== r2(Math.abs(p.gross))) continue;
      matched = i;
      break;
    }
    if (matched === -1) {
      return { ok: false, reason: `no line matches account ${p.accountId} @ ${p.gross}` };
    }
    consumed.add(matched);
    lines[matched] = { ...lines[matched], Amount: r2(Math.abs(p.net)) };
    addGstHst = r2(addGstHst + Math.abs(p.gstHst));
    addPst = r2(addPst + Math.abs(p.pst));
  }

  if (addGstHst > 0) {
    lines.push({
      DetailType: "DepositLineDetail",
      Amount: addGstHst,
      Description: GST_EXTRACTION_MEMO,
      DepositLineDetail: { AccountRef: { value: payableId } },
    });
  }
  if (addPst > 0 && pstPayableId) {
    lines.push({
      DetailType: "DepositLineDetail",
      Amount: addPst,
      Description: GST_EXTRACTION_MEMO,
      DepositLineDetail: { AccountRef: { value: pstPayableId } },
    });
  }
  return { ok: true, lines };
}

/**
 * Apply planned ITC splits to an expense-family line array. Pure. Matches
 * AccountBasedExpenseLineDetail lines by expense account id + gross; reduces
 * to net and appends ONE aggregated ITC line. Credit entities (refunds) carry
 * positive line amounts — the caller passes plan values sign-normalized (abs).
 */
export function applyExpensePlanToLines(
  entityLines: any[],
  plans: Array<{ accountId: string; gross: number; net: number; itc: number }>,
  recoverableId: string
): DepositMatchResult {
  const lines = entityLines.map((l) => ({ ...l }));
  const consumed = new Set<number>();
  let addItc = 0;

  for (const p of plans) {
    let matched = -1;
    for (let i = 0; i < lines.length; i++) {
      if (consumed.has(i)) continue;
      const l = lines[i];
      if (l.DetailType !== "AccountBasedExpenseLineDetail") continue;
      const ref = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
      if (String(ref) !== String(p.accountId)) continue;
      if (r2(Number(l.Amount)) !== r2(Math.abs(p.gross))) continue;
      matched = i;
      break;
    }
    if (matched === -1) {
      return { ok: false, reason: `no line matches account ${p.accountId} @ ${p.gross}` };
    }
    consumed.add(matched);
    lines[matched] = { ...lines[matched], Amount: r2(Math.abs(p.net)) };
    addItc = r2(addItc + Math.abs(p.itc));
  }

  if (addItc > 0) {
    lines.push({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: addItc,
      Description: GST_EXTRACTION_MEMO,
      AccountBasedExpenseLineDetail: { AccountRef: { value: recoverableId } },
    });
  }
  return { ok: true, lines };
}

// ── 4. Entity writers (fetch → match → full-echo update) ────────────────────

/** Report txn_type → QBO entity resource. Expense/Check/CC are all Purchase. */
export function entityResourceFor(txnType: string): "purchase" | "bill" | null {
  const t = (txnType || "").trim().toLowerCase();
  if (t === "bill") return "bill";
  if (/^(expense|check|cash expense|credit card expense|credit card credit|purchase)$/.test(t)) return "purchase";
  return null;
}

async function fetchEntity(realm: string, token: string, resource: string, id: string): Promise<any | null> {
  try {
    const data = await qboRequest<any>(realm, token, `/${resource}/${id}?minorversion=70`);
    // Response key is the capitalized entity name (Deposit / Purchase / Bill).
    return data?.Deposit || data?.Purchase || data?.Bill || null;
  } catch {
    return null;
  }
}

async function updateEntity(
  realm: string,
  token: string,
  resource: string,
  entity: any,
  newLines: any[]
): Promise<void> {
  const { MetaData: _m, domain: _d, TotalAmt: _t, ...core } = entity;
  const existingNote = String(entity.PrivateNote || "");
  const note = existingNote.includes(GST_EXTRACTION_MEMO)
    ? existingNote
    : (existingNote ? existingNote + "\n" : "") + GST_EXTRACTION_MEMO;
  await qboRequest(realm, token, `/${resource}?operation=update&minorversion=70`, {
    method: "POST",
    body: JSON.stringify({ ...core, Line: newLines, PrivateNote: note, sparse: false }),
  });
}

export interface WriteOutcome {
  txn_id: string;
  outcome: "split" | "would_split" | "skipped_closed" | "skipped_stale" | "skipped_already" | "failed";
  detail?: string;
}

/**
 * Split one Deposit per its planned rows. Snapshot-first: the caller persists
 * the returned `snapshot` (full pre-edit entity) BEFORE the write happens.
 */
export async function splitDepositTxn(
  realm: string,
  token: string,
  txnId: string,
  plans: Array<{ accountId: string; gross: number; net: number; gstHst: number; pst: number }>,
  accounts: TaxAccountIds,
  opts: { dryRun: boolean; closingDate: string | null; snapshot: (entity: any) => Promise<void> }
): Promise<WriteOutcome> {
  const entity = await fetchEntity(realm, token, "deposit", txnId);
  if (!entity) return { txn_id: txnId, outcome: "failed", detail: "deposit not found" };
  if (String(entity.PrivateNote || "").includes(GST_EXTRACTION_MEMO)) {
    return { txn_id: txnId, outcome: "skipped_already" };
  }
  if (opts.closingDate && entity.TxnDate && entity.TxnDate <= opts.closingDate) {
    return { txn_id: txnId, outcome: "skipped_closed", detail: `closed ≤ ${opts.closingDate}` };
  }
  const res = applyDepositPlanToLines(entity.Line || [], plans, accounts.payable.id, accounts.pstPayable?.id || null);
  if (!res.ok) return { txn_id: txnId, outcome: "skipped_stale", detail: res.reason };
  if (opts.dryRun) return { txn_id: txnId, outcome: "would_split" };
  try {
    await opts.snapshot(entity);
    await updateEntity(realm, token, "deposit", entity, res.lines!);
    return { txn_id: txnId, outcome: "split" };
  } catch (e: any) {
    return { txn_id: txnId, outcome: "failed", detail: String(e?.message || e).slice(0, 500) };
  }
}

/** Split one expense-family transaction per its planned rows. */
export async function splitExpenseTxn(
  realm: string,
  token: string,
  txnType: string,
  txnId: string,
  plans: Array<{ accountId: string; gross: number; net: number; itc: number }>,
  accounts: TaxAccountIds,
  opts: { dryRun: boolean; closingDate: string | null; snapshot: (entity: any) => Promise<void> }
): Promise<WriteOutcome> {
  const resource = entityResourceFor(txnType);
  if (!resource) return { txn_id: txnId, outcome: "failed", detail: `unsupported type ${txnType}` };
  const entity = await fetchEntity(realm, token, resource, txnId);
  if (!entity) return { txn_id: txnId, outcome: "failed", detail: `${resource} not found` };
  if (String(entity.PrivateNote || "").includes(GST_EXTRACTION_MEMO)) {
    return { txn_id: txnId, outcome: "skipped_already" };
  }
  if (opts.closingDate && entity.TxnDate && entity.TxnDate <= opts.closingDate) {
    return { txn_id: txnId, outcome: "skipped_closed", detail: `closed ≤ ${opts.closingDate}` };
  }
  const res = applyExpensePlanToLines(entity.Line || [], plans, accounts.recoverable.id);
  if (!res.ok) return { txn_id: txnId, outcome: "skipped_stale", detail: res.reason };
  if (opts.dryRun) return { txn_id: txnId, outcome: "would_split" };
  try {
    await opts.snapshot(entity);
    await updateEntity(realm, token, resource, entity, res.lines!);
    return { txn_id: txnId, outcome: "split" };
  } catch (e: any) {
    return { txn_id: txnId, outcome: "failed", detail: String(e?.message || e).slice(0, 500) };
  }
}

// ── 5. Group plan rows per transaction, resolving account NAME → QBO id ─────

export function groupDepositPlans(
  deposits: DepositLinePlan[],
  accountIdByKey: Map<string, string>
): Map<string, Array<{ accountId: string; gross: number; net: number; gstHst: number; pst: number }>> {
  const byTxn = new Map<string, Array<{ accountId: string; gross: number; net: number; gstHst: number; pst: number }>>();
  for (const d of deposits) {
    const accountId = accountIdByKey.get(normalizeAccountKey(d.account));
    if (!accountId) continue; // account unresolvable in live QBO → skip line
    const list = byTxn.get(d.txn_id) || [];
    list.push({ accountId, gross: d.split.gross, net: d.split.net, gstHst: d.split.gstHst, pst: d.split.pst });
    byTxn.set(d.txn_id, list);
  }
  return byTxn;
}

export function groupExpensePlans(
  expenses: ExpenseLinePlan[],
  accountIdByKey: Map<string, string>
): Map<string, { txnType: string; rows: Array<{ accountId: string; gross: number; net: number; itc: number }> }> {
  const byTxn = new Map<string, { txnType: string; rows: Array<{ accountId: string; gross: number; net: number; itc: number }> }>();
  for (const e of expenses) {
    const accountId = accountIdByKey.get(normalizeAccountKey(e.account));
    if (!accountId) continue;
    const g = byTxn.get(e.txn_id) || { txnType: e.txn_type, rows: [] };
    g.rows.push({ accountId, gross: e.split.gross, net: e.split.net, itc: e.split.itc });
    byTxn.set(e.txn_id, g);
  }
  return byTxn;
}
