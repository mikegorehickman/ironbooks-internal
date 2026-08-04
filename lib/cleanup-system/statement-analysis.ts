/**
 * BS Cleanup statement analysis — read uploaded bank / credit-card / loan
 * statement PDFs with Claude, extract the ending balance per account,
 * match each to a live QBO balance-sheet account, and turn the QBO-vs-
 * statement gap into a bank_recon_jobs row. The existing bank_recon
 * module then converts those gaps into proposed reconciling entries the
 * bookkeeper reviews + approves — so an upload directly becomes a
 * recommendation.
 *
 * Claude reads PDFs natively via document content blocks; no server-side
 * PDF text extraction needed.
 */

import { fetchAllAccounts, qboRequest, type QBOAccount } from "@/lib/qbo";

const MODEL = "claude-opus-4-7";

/**
 * Call the Anthropic Messages API directly. The installed SDK (0.30.1)
 * predates PDF document blocks, but PDF support is GA on the API itself —
 * so this one call hits the REST endpoint with raw content blocks rather
 * than risk a repo-wide SDK bump.
 */
async function callClaudePdf(content: any[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192, // ending balances + per-statement transaction lines
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

export interface UploadedStatement {
  /** Original filename — shown back to the bookkeeper for traceability. */
  filename: string;
  /** base64-encoded PDF bytes (no data: prefix). */
  base64: string;
}

export interface StatementLine {
  date: string | null; // YYYY-MM-DD
  description: string | null;
  /** Signed: deposits/credits positive, withdrawals/debits negative. */
  amount: number;
}

export interface ExtractedStatement {
  filename: string;
  institution: string | null;
  account_label: string | null;
  last4: string | null;
  statement_start_date: string | null; // YYYY-MM-DD
  statement_end_date: string | null; // YYYY-MM-DD
  ending_balance: number | null;
  account_kind: "bank" | "credit_card" | "loan" | "unknown";
  /** Claude's match to a QBO account id (or null if it couldn't decide). */
  matched_qbo_account_id: string | null;
  match_confidence: "high" | "medium" | "low" | "none";
  notes: string | null;
  /** Individual statement transactions — drives line-level clearing. */
  lines: StatementLine[];
}

export interface StatementReconResult {
  filename: string;
  matched_account_name: string | null;
  qbo_account_id: string | null;
  qbo_balance: number | null;
  statement_balance: number | null;
  gap: number | null;
  statement_end_date: string | null;
  confidence: ExtractedStatement["match_confidence"];
  status: "reconciled" | "gap_found" | "unmatched" | "no_balance";
  note: string | null;
}

/** Candidate accounts the matcher chooses from — bank, CC, and loan-like
 *  liability accounts, with their live QBO balance + last4. */
export function reconCandidates(accounts: QBOAccount[]) {
  return accounts
    .filter((a) => a.Active !== false)
    .filter((a) => {
      const t = (a.AccountType || "").toLowerCase();
      const st = (a.AccountSubType || "").toLowerCase();
      return (
        t === "bank" ||
        t === "credit card" ||
        st.includes("loan") ||
        st.includes("notes payable") ||
        t === "long term liabilities"
      );
    })
    .map((a) => ({
      id: a.Id,
      name: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      subtype: a.AccountSubType,
      balance: a.CurrentBalance,
    }));
}

const EXTRACTION_SCHEMA = `Return ONLY valid JSON, no prose, shaped exactly:
{
  "statements": [
    // ONE ENTRY PER ACCOUNT, not per PDF. Combined/package statements
    // (one PDF covering e.g. Business Checking AND Business Savings, or a
    // card program with several cards) MUST produce one entry per account,
    // all sharing that PDF's index. A single-account PDF produces one entry.
    {
      "index": <number, which PDF this account came from, 0-based, in the
                order the PDFs were attached>,
      "institution": <string|null>,
      "account_label": <string|null, e.g. "Business Checking ...1234">,
      "last4": <string|null, last 4 digits of the account number>,
      "statement_end_date": <"YYYY-MM-DD"|null, the statement's closing/ending date>,
      "ending_balance": <number|null, the ENDING balance as a signed number;
                         for a credit card or loan a balance OWED is NEGATIVE
                         to match how QBO carries those accounts>,
      "account_kind": <"bank"|"credit_card"|"loan"|"unknown">,
      "matched_qbo_account_id": <string|null, the id from the candidate list
                                 that best matches this statement, by last4
                                 first, then name/institution, then type+amount>,
      "match_confidence": <"high"|"medium"|"low"|"none">,
      "notes": <string|null, one short line if anything is ambiguous>,
      "statement_start_date": <"YYYY-MM-DD"|null, the statement period's start>,
      "lines": [
        {
          "date": <"YYYY-MM-DD"|null>,
          "description": <string|null, the transaction description as printed>,
          "amount": <number, SIGNED: deposits/credits positive, withdrawals/
                     debits/cheques negative>
        }
        // one entry per transaction line on the statement, up to the 300 most
        // recent per statement; [] if the statement has no transaction table
      ]
    }
  ]
}`;

/**
 * Send all PDFs to Claude in one request with the candidate account list,
 * get back the extracted + matched statements.
 */
export async function extractStatements(
  statements: UploadedStatement[],
  candidates: ReturnType<typeof reconCandidates>
): Promise<ExtractedStatement[]> {
  if (statements.length === 0) return [];

  const candidateList = candidates
    .map(
      (c) =>
        `  - id=${c.id} | "${c.name}" | type=${c.type}/${c.subtype} | QBO balance=${c.balance}`
    )
    .join("\n");

  const docs = statements.map((s, i) => ({
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: s.base64 },
    title: `Statement ${i}: ${s.filename}`,
  }));

  const prompt = `You are a bookkeeper's assistant reconciling a client's QuickBooks balance sheet against their actual account statements.

You have been given ${statements.length} statement PDF(s), indexed 0..${statements.length - 1} in the order attached.

Candidate QuickBooks accounts to match each statement to:
${candidateList || "(none provided)"}

For EACH ACCOUNT found in the PDFs, extract the ending balance and match it to the single best candidate account. A PDF may contain MORE THAN ONE account (combined "business package" statements, multi-card programs): emit a separate entry for every account, each with its own ending balance, dates, and transaction lines — never merge two accounts into one entry, and never keep only the first. Sign convention: bank balances positive; credit-card and loan balances OWED are negative (QBO carries liabilities that way). If you cannot confidently match an account to a candidate, set matched_qbo_account_id to null and match_confidence to "none". Never match two entries to the same candidate account — if two seem to fit, keep the better match and mark the other "none".

${EXTRACTION_SCHEMA}`;

  const text = await callClaudePdf([...docs, { type: "text", text: prompt }]);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Statement analysis returned no parseable result");
  const parsed = JSON.parse(jsonMatch[0]);
  const rows: any[] = Array.isArray(parsed.statements) ? parsed.statements : [];

  // ONE ROW PER ACCOUNT — a combined PDF legitimately yields several rows
  // sharing an index. The old mapping was statements.map(one row per file),
  // which silently DROPPED every account after the first on package
  // statements (and the `|| rows[i]` fallback could mis-associate files).
  const usable = rows.filter((r) => r && typeof r === "object");
  const perFileCounts = new Map<number, number>();
  const out: ExtractedStatement[] = [];

  for (const r of usable) {
    // Resolve which PDF the row came from. With a single PDF the index is
    // unambiguous regardless of what the model wrote.
    let idx = typeof r.index === "number" && statements[r.index] ? r.index : -1;
    if (idx === -1 && statements.length === 1) idx = 0;
    if (idx === -1) continue; // multi-PDF + unattributable row → drop, never guess

    const nth = (perFileCounts.get(idx) || 0) + 1;
    perFileCounts.set(idx, nth);

    const lines: StatementLine[] = (Array.isArray(r.lines) ? r.lines : [])
      .filter((l: any) => typeof l?.amount === "number" && Math.abs(l.amount) > 0.005)
      .slice(0, 300)
      .map((l: any) => ({
        date: l.date ?? null,
        description: l.description ? String(l.description).slice(0, 160) : null,
        amount: Number(l.amount),
      }));

    out.push({
      filename: statements[idx].filename,
      institution: r.institution ?? null,
      account_label: r.account_label ?? null,
      last4: r.last4 ? String(r.last4).slice(-4) : null,
      statement_start_date: r.statement_start_date ?? null,
      statement_end_date: r.statement_end_date ?? null,
      ending_balance: typeof r.ending_balance === "number" ? r.ending_balance : null,
      account_kind: ["bank", "credit_card", "loan"].includes(r.account_kind) ? r.account_kind : "unknown",
      matched_qbo_account_id: r.matched_qbo_account_id ? String(r.matched_qbo_account_id) : null,
      match_confidence: ["high", "medium", "low", "none"].includes(r.match_confidence) ? r.match_confidence : "none",
      notes: r.notes ?? null,
      lines,
    });
  }

  // The model returned nothing usable for a file → keep a visible "no
  // balance" placeholder instead of the file vanishing from the results.
  statements.forEach((s, i) => {
    if (!perFileCounts.has(i)) {
      out.push({
        filename: s.filename,
        institution: null, account_label: null, last4: null,
        statement_start_date: null, statement_end_date: null,
        ending_balance: null, account_kind: "unknown",
        matched_qbo_account_id: null, match_confidence: "none",
        notes: "Nothing extractable found in this PDF.",
        lines: [],
      });
    }
  });

  // Disambiguate the display name when one PDF produced several accounts, so
  // the results table doesn't show three identical filenames.
  for (const ex of out) {
    const total = usable.filter(
      (r) => statements[typeof r.index === "number" ? r.index : -1]?.filename === ex.filename
    ).length;
    if (total > 1) {
      const tag = ex.account_label || (ex.last4 ? `…${ex.last4}` : ex.account_kind);
      if (tag && tag !== "unknown") ex.filename = `${ex.filename} — ${tag}`;
    }
  }

  // Never let two entries claim the same QBO account: keep the higher
  // confidence, demote the rest to unmatched for a human to place.
  const RANK: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 };
  const best = new Map<string, ExtractedStatement>();
  for (const ex of out) {
    if (!ex.matched_qbo_account_id) continue;
    const cur = best.get(ex.matched_qbo_account_id);
    if (!cur || RANK[ex.match_confidence] > RANK[cur.match_confidence]) {
      if (cur) { cur.matched_qbo_account_id = null; cur.match_confidence = "none"; cur.notes = "Another statement matched this QBO account more confidently — assign manually."; }
      best.set(ex.matched_qbo_account_id, ex);
    } else {
      ex.matched_qbo_account_id = null;
      ex.match_confidence = "none";
      ex.notes = "Another statement matched this QBO account more confidently — assign manually.";
    }
  }

  return out;
}

// ─── Line-level clearing ────────────────────────────────────────────────────

export interface QboWindowTxn {
  txn_id: string;
  txn_type: string; // Purchase | Deposit
  date: string;
  /** Signed like statement lines: deposits positive, money out negative. */
  amount: number;
  description: string | null;
}

export interface OutstandingItem extends QboWindowTxn {
  age_days: number; // at statement end
  stale: boolean; // older than STALE_DAYS at statement end
}

export const STALE_DAYS = 60;

/**
 * Match QBO transactions against the statement's lines: a QBO txn "clears"
 * when a statement line has the same absolute amount (±1¢) within ±5 days
 * and hasn't already been claimed. What doesn't clear:
 *   - QBO-only  → OUTSTANDING (never hit the bank) — stale when old. These
 *     are Lisa's "old items left on the reconciliation report".
 *   - Statement-only → missing from QBO (unrecorded activity).
 */
export function matchStatementLines(
  qboTxns: QboWindowTxn[],
  lines: StatementLine[],
  statementEndDate: string
): { outstanding: OutstandingItem[]; missingInQbo: StatementLine[]; clearedCount: number } {
  const claimed = new Set<number>();
  const outstanding: OutstandingItem[] = [];
  let clearedCount = 0;

  const dayDiff = (a: string | null, b: string | null) =>
    !a || !b ? Number.POSITIVE_INFINITY : Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

  for (const tx of qboTxns) {
    let hit = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lines.length; i++) {
      if (claimed.has(i)) continue;
      if (Math.abs(Math.abs(lines[i].amount) - Math.abs(tx.amount)) > 0.01) continue;
      const d = dayDiff(lines[i].date, tx.date);
      if (d <= 5 && d < best) {
        best = d;
        hit = i;
      }
    }
    if (hit >= 0) {
      claimed.add(hit);
      clearedCount++;
    } else {
      const age = Math.floor(dayDiff(tx.date, statementEndDate));
      outstanding.push({
        ...tx,
        age_days: Number.isFinite(age) ? age : 0,
        stale: Number.isFinite(age) && age > STALE_DAYS,
      });
    }
  }

  const missingInQbo = lines.filter((_, i) => !claimed.has(i));
  return { outstanding, missingInQbo, clearedCount };
}

/**
 * QBO activity on a bank/CC account in the statement window, signed like
 * statement lines. Coverage: Purchases (cheques/expenses/card charges paid
 * FROM the account — the classic stale item) + Deposits INTO it. Transfers,
 * JEs, and BillPayment cheques aren't line-account-queryable via the API —
 * they simply won't flag, which errs safe (fewer false outstanding items).
 */
export async function fetchQboWindowTxns(
  realmId: string,
  accessToken: string,
  accountId: string,
  startDate: string,
  endDate: string
): Promise<QboWindowTxn[]> {
  const q = async (sql: string) => {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${encodeURIComponent(sql)}`,
      { method: "GET" }
    );
    return data?.QueryResponse || {};
  };

  const out: QboWindowTxn[] = [];
  try {
    const res = await q(
      `SELECT * FROM Purchase WHERE AccountRef = '${accountId}' AND TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );
    for (const p of res.Purchase || []) {
      out.push({
        txn_id: String(p.Id),
        txn_type: "Purchase",
        date: String(p.TxnDate || ""),
        amount: -Math.abs(Number(p.TotalAmt || 0)), // money out
        description: p.EntityRef?.name || p.DocNumber || p.PrivateNote || null,
      });
    }
  } catch { /* best-effort */ }
  try {
    const res = await q(
      `SELECT * FROM Deposit WHERE DepositToAccountRef = '${accountId}' AND TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );
    for (const d of res.Deposit || []) {
      out.push({
        txn_id: String(d.Id),
        txn_type: "Deposit",
        date: String(d.TxnDate || ""),
        amount: Math.abs(Number(d.TotalAmt || 0)), // money in
        description: d.PrivateNote || null,
      });
    }
  } catch { /* best-effort */ }
  return out;
}

/**
 * Full pipeline: fetch QBO accounts, extract statements, upsert a
 * bank_recon_jobs row per matched statement with the QBO-vs-statement gap.
 * Returns a per-file result for display. Does NOT itself create proposed
 * entries — the caller re-runs the bank_recon module so the gaps flow
 * through the existing review path.
 */
export async function analyzeAndReconcile(
  service: any,
  params: {
    runId: string;
    clientLinkId: string;
    qboRealmId: string;
    accessToken: string;
    bookkeeperId: string;
    statements: UploadedStatement[];
  }
): Promise<{ results: StatementReconResult[]; reconRowsWritten: number }> {
  const accounts = await fetchAllAccounts(params.qboRealmId, params.accessToken);
  const candidates = reconCandidates(accounts);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const extracted = await extractStatements(params.statements, candidates);

  const results: StatementReconResult[] = [];
  let reconRowsWritten = 0;

  for (const ex of extracted) {
    const acct = ex.matched_qbo_account_id ? byId.get(ex.matched_qbo_account_id) : null;

    if (!acct) {
      results.push({
        filename: ex.filename,
        matched_account_name: ex.account_label,
        qbo_account_id: null,
        qbo_balance: null,
        statement_balance: ex.ending_balance,
        gap: null,
        statement_end_date: ex.statement_end_date,
        confidence: ex.match_confidence,
        status: "unmatched",
        note: ex.notes || "Couldn't match to a QuickBooks account — pick it manually.",
      });
      continue;
    }
    if (ex.ending_balance === null) {
      results.push({
        filename: ex.filename,
        matched_account_name: acct.name,
        qbo_account_id: acct.id,
        qbo_balance: acct.balance,
        statement_balance: null,
        gap: null,
        statement_end_date: ex.statement_end_date,
        confidence: ex.match_confidence,
        status: "no_balance",
        note: ex.notes || "Couldn't read an ending balance from this statement.",
      });
      continue;
    }

    const gap = Number((acct.balance - ex.ending_balance).toFixed(2));
    const reconciled = Math.abs(gap) < 0.01;

    // Upsert the per-account recon row this run's bank_recon module reads.
    const last4 = ex.last4 || null;
    const { data: existing } = await service
      .from("bank_recon_jobs")
      .select("id")
      .eq("client_link_id", params.clientLinkId)
      .eq("qbo_account_id", acct.id)
      .or(`cleanup_run_id.eq.${params.runId},cleanup_run_id.is.null`)
      .maybeSingle();

    const row = {
      client_link_id: params.clientLinkId,
      cleanup_run_id: params.runId,
      bookkeeper_id: params.bookkeeperId,
      qbo_account_id: acct.id,
      qbo_account_name: acct.name,
      qbo_account_type: acct.type,
      qbo_account_last4: last4,
      statement_ending_balance: ex.ending_balance,
      statement_as_of_date: ex.statement_end_date,
      qbo_balance_at_date: acct.balance,
      gap_amount: gap,
      status: reconciled ? "reconciled" : "gap",
      notes: `From upload "${ex.filename}"${ex.notes ? ` — ${ex.notes}` : ""}`,
    };

    if (existing) {
      await service.from("bank_recon_jobs").update(row as any).eq("id", (existing as any).id);
    } else {
      await service.from("bank_recon_jobs").insert(row as any);
    }
    reconRowsWritten++;

    // Line-level clearing: which QBO transactions never hit the bank
    // (outstanding/stale), and which statement lines never made it into QBO.
    // Fail-soft twice over: the QBO window pull is best-effort, and the
    // persistence columns arrive with migration 111 (pre-migration the update
    // just errors quietly and the balance tie-out above still stands).
    if (ex.lines.length > 0 && ex.statement_end_date) {
      try {
        const start =
          ex.statement_start_date ||
          new Date(new Date(ex.statement_end_date).getTime() - 35 * 86_400_000)
            .toISOString()
            .slice(0, 10);
        const windowTxns = await fetchQboWindowTxns(
          params.qboRealmId,
          params.accessToken,
          acct.id,
          start,
          ex.statement_end_date
        );
        const { outstanding, missingInQbo, clearedCount } = matchStatementLines(
          windowTxns,
          ex.lines,
          ex.statement_end_date
        );
        await service
          .from("bank_recon_jobs")
          .update({
            statement_lines: ex.lines,
            outstanding_items: outstanding,
            line_match_summary: {
              cleared: clearedCount,
              outstanding: outstanding.length,
              stale: outstanding.filter((o) => o.stale).length,
              missing_in_qbo: missingInQbo.length,
              missing_lines: missingInQbo.slice(0, 50),
              window: { start, end: ex.statement_end_date },
            },
          } as any)
          .eq("client_link_id", params.clientLinkId)
          .eq("qbo_account_id", acct.id)
          .eq("cleanup_run_id", params.runId);
      } catch (e: any) {
        console.warn(`[statement-analysis] line-level clearing skipped for ${acct.name}: ${e?.message}`);
      }
    }

    results.push({
      filename: ex.filename,
      matched_account_name: acct.name,
      qbo_account_id: acct.id,
      qbo_balance: acct.balance,
      statement_balance: ex.ending_balance,
      gap,
      statement_end_date: ex.statement_end_date,
      confidence: ex.match_confidence,
      status: reconciled ? "reconciled" : "gap_found",
      note: ex.notes,
    });
  }

  return { results, reconRowsWritten };
}
