import { qboRequest, fetchAllAccounts, getValidToken, type QBOAccount } from "@/lib/qbo";
import { fetchBalancesAsOf } from "@/lib/qbo-balance-sheet";
import {
  extractStatements,
  reconCandidates,
  type StatementLine,
} from "@/lib/cleanup-system/statement-analysis";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";

/**
 * Reconciliation sessions — QBO-style bank/CC reconciliation prepped in SNAP.
 *
 * SNAP does the work (auto-match statement lines vs the QBO ledger, live
 * difference math, culprit-hunting); QBO stays the official record. The QBO
 * v3 API has NO reconcile endpoint (can't set C/R flags), so Finish snapshots
 * the EXACT minimal steps to replay in QBO's /reconcile screen.
 *
 * Sign convention (recon_session_txns.amount): effect on the STATEMENT
 * balance — bank: deposits +, withdrawals −; credit card: charges +,
 * payments −. So universally: beginning + Σ(checked) = ending.
 */

export type ReconTxn = {
  qbo_txn_id: string;
  txn_type: string;
  txn_date: string | null;
  doc_num: string | null;
  payee: string | null;
  memo: string | null;
  amount: number; // signed by effect on statement balance
};

export type AccountKind = "bank" | "credit_card" | "loan";

export function accountKindOf(a: Pick<QBOAccount, "AccountType">): AccountKind {
  const t = (a.AccountType || "").toLowerCase();
  if (t === "bank") return "bank";
  if (t === "credit card") return "credit_card";
  return "loan";
}

const money = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every transaction touching one bank/CC account in a date window, with QBO
 * ids — via per-entity queries (the TransactionList report's account filter
 * is silently ignored by QBO, so it can't be trusted for this). Entities the
 * realm doesn't support just add a warning instead of failing the fetch.
 */
export async function fetchAccountWindowTxns(
  realmId: string,
  accessToken: string,
  account: { id: string; kind: AccountKind },
  startDate: string,
  endDate: string
): Promise<{ txns: ReconTxn[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out = new Map<string, ReconTxn>();
  const add = (t: ReconTxn) => {
    if (t.qbo_txn_id) out.set(`${t.txn_type}:${t.qbo_txn_id}`, t);
  };
  const isCC = account.kind === "credit_card";
  const dateClause = `TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`;

  async function q(entity: string, where: string): Promise<any[]> {
    try {
      const sql = `SELECT * FROM ${entity} WHERE ${where} MAXRESULTS 1000`;
      const data: any = await qboRequest(realmId, accessToken, `/query?query=${encodeURIComponent(sql)}`);
      return data?.QueryResponse?.[entity] || [];
    } catch (e: any) {
      warnings.push(`${entity} query skipped: ${String(e?.message || e).slice(0, 120)}`);
      return [];
    }
  }

  // Purchases posted to this account (expenses/cheques from bank; charges on CC).
  for (const p of await q("Purchase", `AccountRef = '${account.id}' AND ${dateClause}`)) {
    const refund = p.Credit === true;
    const base = money(p.TotalAmt);
    add({
      qbo_txn_id: String(p.Id),
      txn_type: refund ? (isCC ? "CC Credit" : "Refund") : isCC ? "CC Charge" : "Expense",
      txn_date: p.TxnDate || null,
      doc_num: p.DocNumber || null,
      payee: p.EntityRef?.name || null,
      memo: p.PrivateNote || null,
      amount: isCC ? (refund ? -base : base) : refund ? base : -base,
    });
  }

  if (!isCC) {
    for (const d of await q("Deposit", `DepositToAccountRef = '${account.id}' AND ${dateClause}`)) {
      add({
        qbo_txn_id: String(d.Id),
        txn_type: "Deposit",
        txn_date: d.TxnDate || null,
        doc_num: d.DocNumber || null,
        payee: null,
        memo: d.PrivateNote || null,
        amount: money(d.TotalAmt),
      });
    }
  }

  // Transfers — date-window query, filtered client-side. "To" debits the
  // account: bank balance up (+); CC owed down (−).
  for (const t of await q("Transfer", dateClause)) {
    const from = String(t.FromAccountRef?.value || "");
    const to = String(t.ToAccountRef?.value || "");
    if (from !== account.id && to !== account.id) continue;
    const amt = money(t.Amount);
    const debit = to === account.id;
    add({
      qbo_txn_id: String(t.Id),
      txn_type: "Transfer",
      txn_date: t.TxnDate || null,
      doc_num: t.DocNumber || null,
      payee: debit ? `From ${t.FromAccountRef?.name || "account"}` : `To ${t.ToAccountRef?.name || "account"}`,
      memo: t.PrivateNote || null,
      amount: isCC ? (debit ? -amt : amt) : debit ? amt : -amt,
    });
  }

  // Journal entries — scan lines for this account. Debit: bank +, CC −(owed).
  for (const je of await q("JournalEntry", dateClause)) {
    let net = 0;
    let touches = false;
    for (const line of je.Line || []) {
      const det = line.JournalEntryLineDetail;
      if (!det || String(det.AccountRef?.value || "") !== account.id) continue;
      touches = true;
      const amt = money(line.Amount);
      const debit = det.PostingType === "Debit";
      net += isCC ? (debit ? -amt : amt) : debit ? amt : -amt;
    }
    if (!touches) continue;
    add({
      qbo_txn_id: String(je.Id),
      txn_type: "Journal Entry",
      txn_date: je.TxnDate || null,
      doc_num: je.DocNumber || null,
      payee: null,
      memo: je.PrivateNote || null,
      amount: net,
    });
  }

  // Credit-card payments (the "pay down credit card" entity).
  for (const cp of await q("CreditCardPayment", dateClause)) {
    const ccId = String(cp.CreditCardAccountRef?.value || "");
    const bankId = String(cp.BankAccountRef?.value || "");
    if (ccId !== account.id && bankId !== account.id) continue;
    const amt = money(cp.Amount ?? cp.TotalAmt);
    add({
      qbo_txn_id: String(cp.Id),
      txn_type: "CC Payment",
      txn_date: cp.TxnDate || null,
      doc_num: null,
      payee: ccId === account.id ? `From ${cp.BankAccountRef?.name || "bank"}` : `To ${cp.CreditCardAccountRef?.name || "card"}`,
      memo: cp.PrivateNote || null,
      amount: -amt, // reduces CC owed / reduces bank balance
    });
  }

  if (!isCC) {
    for (const sr of await q("SalesReceipt", `DepositToAccountRef = '${account.id}' AND ${dateClause}`)) {
      add({
        qbo_txn_id: String(sr.Id),
        txn_type: "Sales Receipt",
        txn_date: sr.TxnDate || null,
        doc_num: sr.DocNumber || null,
        payee: sr.CustomerRef?.name || null,
        memo: sr.PrivateNote || null,
        amount: money(sr.TotalAmt),
      });
    }
    for (const pm of await q("Payment", `DepositToAccountRef = '${account.id}' AND ${dateClause}`)) {
      add({
        qbo_txn_id: String(pm.Id),
        txn_type: "Payment",
        txn_date: pm.TxnDate || null,
        doc_num: pm.PaymentRefNum || null,
        payee: pm.CustomerRef?.name || null,
        memo: pm.PrivateNote || null,
        amount: money(pm.TotalAmt),
      });
    }
  }

  // Bill payments — cheque from bank / charge on CC, filtered client-side.
  for (const bp of await q("BillPayment", dateClause)) {
    const amt = money(bp.TotalAmt);
    const bankId = String(bp.CheckPayment?.BankAccountRef?.value || "");
    const ccId = String(bp.CreditCardPayment?.CCAccountRef?.value || "");
    if (bankId === account.id && !isCC) {
      add({
        qbo_txn_id: String(bp.Id),
        txn_type: "Bill Payment",
        txn_date: bp.TxnDate || null,
        doc_num: bp.DocNumber || null,
        payee: bp.VendorRef?.name || null,
        memo: bp.PrivateNote || null,
        amount: -amt,
      });
    } else if (ccId === account.id && isCC) {
      add({
        qbo_txn_id: String(bp.Id),
        txn_type: "Bill Payment (card)",
        txn_date: bp.TxnDate || null,
        doc_num: bp.DocNumber || null,
        payee: bp.VendorRef?.name || null,
        memo: bp.PrivateNote || null,
        amount: amt,
      });
    }
  }

  const txns = [...out.values()].sort((a, b) => (a.txn_date || "").localeCompare(b.txn_date || ""));
  return { txns, warnings };
}

/** Greedy match: abs-amount ±1¢ within ±5 days, closest date wins. Returns
 *  per-txn matched line + the statement lines nothing in QBO explains. */
export function matchTxnsToLines(
  txns: ReconTxn[],
  lines: StatementLine[]
): { matched: Map<string, StatementLine>; unmatchedLines: StatementLine[] } {
  const claimed = new Set<number>();
  const matched = new Map<string, StatementLine>();
  const dayDiff = (a: string | null, b: string | null) =>
    !a || !b ? Number.POSITIVE_INFINITY : Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

  for (const tx of txns) {
    let hit = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lines.length; i++) {
      if (claimed.has(i)) continue;
      if (Math.abs(Math.abs(lines[i].amount) - Math.abs(tx.amount)) > 0.01) continue;
      const d = dayDiff(lines[i].date, tx.txn_date);
      if (d <= 5 && d < best) {
        best = d;
        hit = i;
      }
    }
    if (hit >= 0) {
      claimed.add(hit);
      matched.set(`${tx.txn_type}:${tx.qbo_txn_id}`, lines[hit]);
    }
  }
  return { matched, unmatchedLines: lines.filter((_, i) => !claimed.has(i)) };
}

export type SessionMath = {
  beginning: number;
  clearedIn: number; // Σ checked amount > 0
  clearedOut: number; // Σ checked amount < 0 (negative number)
  clearedBalance: number; // beginning + clearedIn + clearedOut
  ending: number;
  difference: number; // ending − clearedBalance; 0 = balanced
  checkedCount: number;
};

export function computeSessionMath(
  session: { beginning_balance: number | null; ending_balance: number },
  txns: Array<{ origin: string; checked: boolean; amount: number }>
): SessionMath {
  const beginning = Number(session.beginning_balance || 0);
  let clearedIn = 0;
  let clearedOut = 0;
  let checkedCount = 0;
  for (const t of txns) {
    if (t.origin !== "qbo" || !t.checked) continue;
    checkedCount++;
    const a = Number(t.amount || 0);
    if (a >= 0) clearedIn += a;
    else clearedOut += a;
  }
  const clearedBalance = beginning + clearedIn + clearedOut;
  const ending = Number(session.ending_balance || 0);
  return {
    beginning,
    clearedIn: Math.round(clearedIn * 100) / 100,
    clearedOut: Math.round(clearedOut * 100) / 100,
    clearedBalance: Math.round(clearedBalance * 100) / 100,
    ending,
    difference: Math.round((ending - clearedBalance) * 100) / 100,
    checkedCount,
  };
}

export type QboInstructions = {
  reconcile_url: string;
  account_name: string;
  ending_balance: number;
  ending_date: string;
  mode: "select_all" | "uncheck_list";
  uncheck: Array<{ date: string | null; payee: string | null; amount: number; type: string | null }>;
  add_first: Array<{ date: string | null; description: string | null; amount: number }>;
  steps: string[];
};

/** The exact, minimal QBO actions that replay this session — Lisa's flow:
 *  paste balance → paste date → Select all → uncheck N → Finish now. */
export function buildQboInstructions(
  session: { qbo_account_id: string; qbo_account_name: string; ending_balance: number; statement_end_date: string },
  txns: Array<{ origin: string; checked: boolean; amount: number; txn_date: string | null; payee: string | null; txn_type: string | null; matched_line_desc?: string | null; memo?: string | null }>
): QboInstructions {
  const qbo = txns.filter((t) => t.origin === "qbo");
  const unchecked = qbo.filter((t) => !t.checked);
  const addFirst = txns
    .filter((t) => t.origin === "statement_only")
    .map((t) => ({ date: t.txn_date, description: t.matched_line_desc || t.memo || t.payee || null, amount: t.amount }));

  const steps: string[] = [];
  if (addFirst.length > 0) {
    steps.push(
      `FIRST — record ${addFirst.length} transaction${addFirst.length === 1 ? "" : "s"} in QBO that are on the statement but missing from the books (listed below). QBO cannot balance without them.`
    );
  }
  steps.push(`Open the reconcile screen for "${session.qbo_account_name}" (button below).`);
  steps.push(`Ending balance: enter ${session.ending_balance.toFixed(2)} (copy button below).`);
  steps.push(`Ending date: enter ${session.statement_end_date}.`);
  steps.push(`Click Start reconciling.`);
  if (unchecked.length === 0) {
    steps.push(`Tick the Select-all checkbox at the top of the list — every transaction in this window belongs on the statement.`);
  } else {
    steps.push(`Tick Select-all, then UNCHECK the ${unchecked.length} transaction${unchecked.length === 1 ? "" : "s"} listed below — they haven't cleared the bank.`);
  }
  steps.push(`The difference should read $0.00 — click Finish now.`);

  return {
    reconcile_url: `https://app.qbo.intuit.com/app/reconcile?accountId=${encodeURIComponent(session.qbo_account_id)}`,
    account_name: session.qbo_account_name,
    ending_balance: session.ending_balance,
    ending_date: session.statement_end_date,
    mode: unchecked.length === 0 ? "select_all" : "uncheck_list",
    uncheck: unchecked.map((t) => ({ date: t.txn_date, payee: t.payee, amount: t.amount, type: t.txn_type })),
    add_first: addFirst,
    steps,
  };
}

/**
 * Create a session: resolve the account, pick the window, pull the QBO
 * ledger, extract + auto-match statement lines when a filed statement PDF
 * exists, and persist session + rows. Returns the new session id.
 */
export async function createReconSession(
  service: any,
  clientLink: { id: string; qbo_realm_id: string },
  input: {
    account_id: string;
    statement_id?: string | null;
    ending_balance?: number | null;
    statement_end_date?: string | null;
    statement_start_date?: string | null;
  },
  userId: string
): Promise<{ id: string } | { error: string }> {
  let token: string;
  try {
    token = await getValidToken(clientLink.id, service, "recon-session");
  } catch (e: any) {
    return { error: `QuickBooks isn't connected for this client (${e?.message || "no token"}).` };
  }

  const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, token);
  const account = accounts.find((a) => String(a.Id) === String(input.account_id));
  if (!account) return { error: "Account not found in QuickBooks." };
  const kind = accountKindOf(account);

  // Statement-driven or manual truth values.
  let stmt: any = null;
  if (input.statement_id) {
    const { data } = await service
      .from("client_statements")
      .select("id, storage_path, ending_balance, statement_end_date, original_name, display_name")
      .eq("id", input.statement_id)
      .maybeSingle();
    stmt = data;
  }
  const endingBalance = input.ending_balance ?? (stmt?.ending_balance != null ? Number(stmt.ending_balance) : null);
  const endDate = input.statement_end_date || stmt?.statement_end_date || null;
  if (endingBalance == null || !endDate) {
    return { error: "Need an ending balance and statement end date (pick a processed statement or enter them manually)." };
  }

  // Reuse an open session for the same account + end date instead of duplicating.
  const { data: existing } = await service
    .from("recon_sessions")
    .select("id")
    .eq("client_link_id", clientLink.id)
    .eq("qbo_account_id", String(account.Id))
    .eq("statement_end_date", endDate)
    .eq("status", "in_progress")
    .maybeSingle();
  if (existing) return { id: existing.id };

  // Window start + beginning balance: prior finished session chains; else QBO
  // balance the day before the window opens.
  const { data: prior } = await service
    .from("recon_sessions")
    .select("id, ending_balance, statement_end_date")
    .eq("client_link_id", clientLink.id)
    .eq("qbo_account_id", String(account.Id))
    .eq("status", "finished")
    .lt("statement_end_date", endDate)
    .order("statement_end_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  let startDate = input.statement_start_date || null;
  let beginning: number | null = null;
  let beginningSource = "manual";
  if (prior) {
    beginning = Number(prior.ending_balance);
    beginningSource = "prior_session";
    if (!startDate) {
      const d = new Date(prior.statement_end_date + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 1);
      startDate = d.toISOString().slice(0, 10);
    }
  }
  if (!startDate) {
    const d = new Date(endDate + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 34);
    startDate = d.toISOString().slice(0, 10);
  }
  if (beginning == null) {
    try {
      const dayBefore = new Date(startDate + "T00:00:00Z");
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const balances = await fetchBalancesAsOf(clientLink.qbo_realm_id, token, dayBefore.toISOString().slice(0, 10));
      const b = balances.get(String(account.Id));
      if (b != null) {
        beginning = b;
        beginningSource = "qbo_asof";
      }
    } catch {
      /* fall through to 0 */
    }
  }
  if (beginning == null) beginning = 0;

  const { txns } = await fetchAccountWindowTxns(
    clientLink.qbo_realm_id,
    token,
    { id: String(account.Id), kind },
    startDate,
    endDate
  );

  // Statement lines → auto-match. Extraction failure degrades to an unmatched
  // worksheet (bookkeeper checks rows manually) rather than blocking.
  let lines: StatementLine[] = [];
  if (stmt?.storage_path) {
    try {
      const dl = await service.storage.from(CLIENT_UPLOADS_BUCKET).download(stmt.storage_path);
      if (dl.data) {
        const buf = Buffer.from(await dl.data.arrayBuffer());
        const extracted = await extractStatements(
          [{ filename: stmt.original_name || stmt.display_name || "statement.pdf", base64: buf.toString("base64") }],
          reconCandidates(accounts)
        );
        lines = extracted[0]?.lines || [];
      }
    } catch {
      lines = [];
    }
  }
  const { matched, unmatchedLines } = matchTxnsToLines(txns, lines);

  const { data: sessionRow, error: sessErr } = await service
    .from("recon_sessions")
    .insert({
      client_link_id: clientLink.id,
      qbo_account_id: String(account.Id),
      qbo_account_name: account.Name,
      account_kind: kind,
      statement_id: stmt?.id || null,
      beginning_balance: beginning,
      beginning_source: beginningSource,
      ending_balance: endingBalance,
      statement_start_date: startDate,
      statement_end_date: endDate,
      created_by: userId,
    })
    .select("id")
    .single();
  if (sessErr) return { error: sessErr.message };

  const rows = [
    ...txns.map((t) => {
      const line = matched.get(`${t.txn_type}:${t.qbo_txn_id}`) || null;
      return {
        session_id: sessionRow.id,
        origin: "qbo",
        qbo_txn_id: t.qbo_txn_id,
        txn_type: t.txn_type,
        txn_date: t.txn_date,
        doc_num: t.doc_num,
        payee: t.payee,
        memo: t.memo,
        amount: t.amount,
        checked: !!line,
        match_source: line ? "auto_statement" : null,
        matched_line_date: line?.date || null,
        matched_line_desc: line?.description || null,
      };
    }),
    ...unmatchedLines.map((l) => ({
      session_id: sessionRow.id,
      origin: "statement_only",
      qbo_txn_id: null,
      txn_type: null,
      txn_date: l.date,
      doc_num: null,
      payee: null,
      memo: null,
      amount: l.amount,
      checked: false,
      match_source: null,
      matched_line_date: l.date,
      matched_line_desc: l.description,
    })),
  ];
  if (rows.length > 0) {
    const { error: txErr } = await service.from("recon_session_txns").insert(rows);
    if (txErr) return { error: `Session created but rows failed: ${txErr.message}` };
  }
  return { id: sessionRow.id };
}
