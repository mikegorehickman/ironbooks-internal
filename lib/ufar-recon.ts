import Anthropic from "@anthropic-ai/sdk";
import { qboRequest, fetchAllAccounts } from "./qbo";
import { scanUfAudit } from "./uf-audit";
import { getValidToken } from "./qbo-reclass";
import { fetchPLDetailAll } from "./qbo-reports";

/**
 * UF/AR Reconciler — the one-button version of the manual workflow:
 * "export UF, AR, bank deposits and revenue to CSV, run it through Claude,
 * ask it to match deposits to revenue, identify the true A/R balance,
 * reconcile A/R and UF, and build a step-by-step clearing list."
 *
 * Pipeline:
 *   1. Pull all four datasets straight from QBO (no CSVs):
 *      UF ledger (scanUfAudit — orphans, duplicates, already-swept),
 *      open A/R (invoices with balance), bank deposits, revenue detail.
 *   2. Deterministic matching first — exact amount + date proximity is
 *      provable and free. Only the ambiguous remainder goes to the model.
 *   3. Claude (Opus) reconciles the remainder and writes the clearing plan:
 *      true A/R, what's double-counted, and numbered steps referencing the
 *      SNAP tool that executes each one.
 *
 * The result persists on ufar_recon_runs with a checkable step list.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-8";

interface OpenInvoice {
  id: string;
  doc: string | null;
  date: string;
  customer: string;
  total: number;
  balance: number;
}
interface DepositRow {
  id: string;
  date: string;
  amount: number;
  memo: string | null;
  to_account: string | null;
  line_accounts: string[];
}

async function fetchOpenInvoices(realmId: string, token: string): Promise<OpenInvoice[]> {
  const out: OpenInvoice[] = [];
  let start = 1;
  for (let page = 0; page < 5; page++) {
    const q = encodeURIComponent(
      `SELECT * FROM Invoice WHERE Balance > '0' ORDER BY TxnDate STARTPOSITION ${start} MAXRESULTS 100`
    );
    const data: any = await qboRequest(realmId, token, `/query?query=${q}`, { method: "GET" });
    const rows: any[] = data?.QueryResponse?.Invoice || [];
    for (const r of rows) {
      out.push({
        id: String(r.Id),
        doc: r.DocNumber || null,
        date: r.TxnDate,
        customer: r.CustomerRef?.name || "Unknown",
        total: Number(r.TotalAmt || 0),
        balance: Number(r.Balance || 0),
      });
    }
    if (rows.length < 100) break;
    start += 100;
  }
  return out;
}

async function fetchDeposits(realmId: string, token: string, sinceYmd: string): Promise<DepositRow[]> {
  const out: DepositRow[] = [];
  let start = 1;
  for (let page = 0; page < 5; page++) {
    const q = encodeURIComponent(
      `SELECT * FROM Deposit WHERE TxnDate >= '${sinceYmd}' ORDER BY TxnDate DESC STARTPOSITION ${start} MAXRESULTS 100`
    );
    const data: any = await qboRequest(realmId, token, `/query?query=${q}`, { method: "GET" });
    const rows: any[] = data?.QueryResponse?.Deposit || [];
    for (const r of rows) {
      out.push({
        id: String(r.Id),
        date: r.TxnDate,
        amount: Number(r.TotalAmt || 0),
        memo: r.PrivateNote || null,
        to_account: r.DepositToAccountRef?.name || null,
        line_accounts: (r.Line || [])
          .map((l: any) => l?.DepositLineDetail?.AccountRef?.name)
          .filter(Boolean),
      });
    }
    if (rows.length < 100) break;
    start += 100;
  }
  return out;
}

export interface UfArReconResult {
  summary: {
    uf_balance: number;
    uf_orphans: number;
    uf_duplicates: number;
    booked_ar: number;
    true_ar: number | null;
    open_invoices: number;
    deposits_pulled: number;
    deposits_matched: number;
    revenue_rows: number;
  };
  report: {
    ar_explained: string;
    uf_explained: string;
    steps: Array<{
      n: number;
      title: string;
      detail: string;
      tool: string; // uf_audit | ar_recovery | qbo | je | none
      amount: number | null;
    }>;
  };
}

export async function runUfArRecon(
  service: any,
  clientLink: { id: string; qbo_realm_id: string; client_name: string },
  opts?: { windowDays?: number }
): Promise<UfArReconResult> {
  const windowDays = opts?.windowDays ?? 365;
  const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const token = await getValidToken(clientLink.id, service);

  // ── 1. Pull all four datasets in parallel ──
  const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, token);
  const ufAccount = accounts.find(
    (a: any) => a.Active !== false && /undeposited/i.test(a.Name)
  );
  const [uf, invoices, deposits, plRows] = await Promise.all([
    ufAccount
      ? scanUfAudit(clientLink.qbo_realm_id, token, ufAccount.Id).catch(() => null)
      : Promise.resolve(null),
    fetchOpenInvoices(clientLink.qbo_realm_id, token),
    fetchDeposits(clientLink.qbo_realm_id, token, since),
    fetchPLDetailAll(clientLink.qbo_realm_id, token, since, new Date().toISOString().slice(0, 10), "Accrual"),
  ]);
  const revenue = plRows.filter((r) => /income/i.test(r.section));

  // ── 2. Deterministic pass: deposits ↔ revenue (exact amount, ±3 days) ──
  const revByAmount = new Map<string, typeof revenue>();
  for (const r of revenue) {
    const k = Math.abs(r.amount).toFixed(2);
    (revByAmount.get(k) || revByAmount.set(k, []).get(k)!).push(r);
  }
  const matchedDeposits = new Set<string>();
  const near = (a: string, b: string) =>
    Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= 3 * 86400000;
  for (const d of deposits) {
    const candidates = revByAmount.get(Math.abs(d.amount).toFixed(2)) || [];
    if (candidates.some((c) => near(c.date, d.date))) matchedDeposits.add(d.id);
  }
  const unmatchedDeposits = deposits.filter((d) => !matchedDeposits.has(d.id));

  const orphans = uf?.payments?.filter((p: any) => p.classification === "orphan") || [];
  const dupes = uf?.payments?.filter((p: any) => p.suspected_duplicate) || [];
  const bookedAr = invoices.reduce((s, i) => s + i.balance, 0);
  const ufBalance =
    uf?.uf_account_current_balance ??
    orphans.reduce((s: number, p: any) => s + (p.amount || 0), 0);

  // ── 3. Claude reconciles the remainder + writes the plan ──
  const compact = {
    client: clientLink.client_name,
    uf: {
      balance: ufBalance,
      orphans: orphans.slice(0, 60).map((p: any) => ({
        id: p.qbo_payment_id, date: p.payment_date, customer: p.customer_name,
        amount: p.payment_amount, type: p.qbo_payment_txn_type, ref: p.payment_ref_num,
      })),
      duplicates: dupes.slice(0, 30).map((p: any) => ({
        id: p.qbo_payment_id, date: p.payment_date, customer: p.customer_name,
        amount: p.payment_amount, dup_of: p.duplicate_of_payment_id, why: p.duplicate_reason,
      })),
    },
    open_invoices: invoices.slice(0, 80).map((i) => ({
      id: i.id, doc: i.doc, date: i.date, customer: i.customer, balance: i.balance,
    })),
    unmatched_deposits: unmatchedDeposits.slice(0, 60).map((d) => ({
      id: d.id, date: d.date, amount: d.amount, to: d.to_account, lines: d.line_accounts, memo: d.memo?.slice(0, 60),
    })),
    stats: {
      deposits_total: deposits.length,
      deposits_matched_to_revenue: matchedDeposits.size,
      revenue_rows: revenue.length,
      booked_ar: bookedAr,
    },
  };

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: `You are a senior bookkeeper reconciling Undeposited Funds and Accounts Receivable for a painting contractor. Deposits already matched to revenue deterministically are NOT in the data — only the problems are. Your jobs:
1. Identify the TRUE A/R balance: open invoices whose money has actually already arrived (a UF payment or an unmatched deposit for the same customer/amount) are NOT真 receivable — they're application problems.
2. Explain what the UF balance is made of and how each piece clears (apply to invoice / sweep to bank via deposit / void duplicate / write off).
3. Watch for double-counted revenue: an unmatched deposit booked straight to an income account while an invoice+payment for the same money sits in UF means revenue is counted twice.
Return STRICT JSON only:
{"true_ar": number, "ar_explained": "2-4 sentences", "uf_explained": "2-4 sentences", "steps": [{"n":1,"title":"short imperative","detail":"exact instruction incl. names/amounts/dates","tool":"uf_audit|ar_recovery|qbo|je|none","amount": number|null}]}
Order steps by impact. Max 20 steps; batch identical actions into one step. tool = which SNAP surface executes it: uf_audit (UF Audit tool), ar_recovery (A/R Recovery), je (journal entry), qbo (do it in QuickBooks directly), none (informational).`,
    messages: [{ role: "user", content: JSON.stringify(compact) }],
  });

  const text = resp.content[0]?.type === "text" ? resp.content[0].text : "{}";
  let parsed: any = {};
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    parsed = { true_ar: null, ar_explained: "AI response could not be parsed — raw data pulled successfully; re-run.", uf_explained: "", steps: [] };
  }

  return {
    summary: {
      uf_balance: Math.round(ufBalance * 100) / 100,
      uf_orphans: orphans.length,
      uf_duplicates: dupes.length,
      booked_ar: Math.round(bookedAr * 100) / 100,
      true_ar: typeof parsed.true_ar === "number" ? Math.round(parsed.true_ar * 100) / 100 : null,
      open_invoices: invoices.length,
      deposits_pulled: deposits.length,
      deposits_matched: matchedDeposits.size,
      revenue_rows: revenue.length,
    },
    report: {
      ar_explained: String(parsed.ar_explained || ""),
      uf_explained: String(parsed.uf_explained || ""),
      steps: Array.isArray(parsed.steps)
        ? parsed.steps.slice(0, 20).map((s: any, i: number) => ({
            n: i + 1,
            title: String(s.title || "").slice(0, 120),
            detail: String(s.detail || "").slice(0, 600),
            tool: ["uf_audit", "ar_recovery", "qbo", "je", "none"].includes(s.tool) ? s.tool : "none",
            amount: typeof s.amount === "number" ? s.amount : null,
          }))
        : [],
    },
  };
}
