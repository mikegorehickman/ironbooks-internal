import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  getValidToken, fetchAllAccountsIncludingInactive, qboRequest, qboErrorResponse,
  inactivateAccount, renameAccount, type QBOAccount,
} from "@/lib/qbo";
import { fetchBalancesAsOf } from "@/lib/qbo-balance-sheet";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { fetchTransactionsForAccount, reclassifyTransactionLines, type SupportedTxType } from "@/lib/qbo-reclass";
import { reactivateAccount } from "@/lib/coa-reclass-je";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const MAX_TXNS_PER_UNDO = 300;

/**
 * POST /api/admin/coa-audit/revert  { client_link_id }   (READ-ONLY PLAN)
 *
 * Builds — and ONLY builds — the reversal plan for undoing a COA-audit
 * "Fix all" (Clean Cut incident, 2026-07-18: a completed manual cleanup was
 * overwritten). No writes. This produces the exact steps a human or a later
 * guarded executor follows, from two reliable signals:
 *
 *  1. RE-TYPES: the engine renamed each original account aside with a
 *     "(pre-retype …)" suffix and left it INACTIVE with its ORIGINAL type
 *     intact, then created a new same-name account of the master type and
 *     drained into it. So the original is recoverable — pair the active
 *     twin with its "(pre-retype)" inactive original, move the balance back,
 *     reactivate the original (drop the suffix), inactivate the created twin.
 *
 *  2. MERGES: every moved txn/JE carries the memo
 *     `SNAP COA merge: "source" → "target"`, and audit_log records each
 *     merge — so the moves are findable and the direction is known.
 *
 * NB: this endpoint does NOT write to QBO. Execution is a separate, guarded,
 * one-account-at-a-time step that only runs on explicit go-ahead.
 */
const PRE_RETYPE_RE = /\s*\(pre-retype[^)]*\)\s*$/i;
const norm = (s: string) => s.replace(PRE_RETYPE_RE, "").replace(/\s*\(deleted\)\s*$/i, "").trim().toLowerCase();

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = String(body.client_link_id || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", clientLinkId)
    .maybeSingle();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });

  // ── EXECUTE ONE UNDO ──────────────────────────────────────────────────
  // One operation per call, dry-run by default. The undo payloads come from
  // the plan below (each row carries its own). Mike triggers each from the
  // browser, verifies in QBO, then fires the next.
  if (body.undo && typeof body.undo === "object") {
    try {
      return await undoOneOperation({
        service,
        userId: user.id,
        client,
        clientLinkId,
        undo: body.undo,
        dryRun: body.dry_run !== false, // MUST pass dry_run:false to write
        startedAt: Date.now(),
      });
    } catch (err: any) {
      return qboErrorResponse(err);
    }
  }

  try {
    const realm = client.qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);
    // BS balances (by account id) for balance-sheet accounts; P&L balances (by
    // account NAME) for income/COGS/expense accounts — the Balance Sheet report
    // omits P&L accounts, so the wage/COGS twins would otherwise read $0. YTD
    // covers the whole current year so a just-drained twin still shows its total.
    const year = new Date().getFullYear();
    const [accounts, balances, pl] = await Promise.all([
      fetchAllAccountsIncludingInactive(realm, token),
      fetchBalancesAsOf(realm, token, new Date().toISOString().slice(0, 10)).catch(() => new Map<string, number>()),
      fetchProfitAndLoss(realm, token, `${year}-01-01`, new Date().toISOString().slice(0, 10)).catch(() => null),
    ]);
    const plByName = new Map<string, number>();
    for (const li of (pl?.lineItems as any[]) || []) {
      const k = String(li.label || "").trim().toLowerCase();
      plByName.set(k, Math.round(((plByName.get(k) || 0) + (Number(li.amount) || 0)) * 100) / 100);
    }
    // Prefer the P&L balance (by name) for P&L accounts, else the BS balance.
    const balOf = (acct: any) => {
      const byName = plByName.get(String(acct?.Name || "").trim().toLowerCase());
      if (byName != null && Math.abs(byName) > 0.005) return byName;
      return Math.round((balances.get(String(acct?.Id)) ?? 0) * 100) / 100;
    };

    // ── 1. Re-type reversals — pair "(pre-retype)" originals with their twins ──
    const preRetype = accounts.filter((a: any) => PRE_RETYPE_RE.test(String(a.Name || "")));
    const activeByNorm = new Map<string, any>();
    for (const a of accounts) {
      if (a.Active !== false && !PRE_RETYPE_RE.test(String(a.Name || ""))) activeByNorm.set(norm(String(a.Name)), a);
    }
    const retypeReversals = preRetype.map((orig: any) => {
      const base = String(orig.Name).replace(PRE_RETYPE_RE, "").trim();
      const twin = activeByNorm.get(norm(base)) || null;
      return {
        original_account: base,
        original_id: String(orig.Id),
        original_type: orig.AccountType,
        original_active: orig.Active !== false,
        created_twin: twin ? twin.Name : null,
        created_twin_id: twin ? String(twin.Id) : null,
        created_twin_type: twin ? twin.AccountType : null,
        balance_on_twin_to_move_back: twin ? balOf(twin) : 0,
        steps: twin
          ? [
              `Move ${twin.AccountType} balance ($${Math.abs(balOf(twin)).toLocaleString()}) from "${twin.Name}" back to "${base}"`,
              `Reactivate "${base}" (drop the "(pre-retype)" suffix, restore type ${orig.AccountType})`,
              `Inactivate the created twin "${twin.Name}"`,
            ]
          : [`Reactivate "${base}" — no active twin found; verify the balance manually`],
        // Fire this back at the same endpoint to execute (dry-run first).
        undo_payload: twin
          ? {
              client_link_id: clientLinkId,
              dry_run: true,
              undo: {
                source_name: String(orig.Name),
                target_name: String(twin.Name),
                memo: `SNAP COA retype: "${base}" → ${twin.AccountType}`,
                retype: true,
              },
            }
          : null,
      };
    });

    // ── 2. Merge reversals — from audit_log ──
    const { data: mergeRows } = await (service as any)
      .from("audit_log")
      .select("request_payload, occurred_at")
      .filter("request_payload->>client_link_id", "eq", clientLinkId)
      .eq("event_type", "coa_audit_merge")
      .order("occurred_at", { ascending: false })
      .limit(200);
    const mergeReversals = ((mergeRows as any[]) || []).map((r) => {
      const p = r.request_payload || {};
      return {
        at: r.occurred_at,
        source: p.source,
        target: p.target,
        amount_swept: p.amount_swept,
        lines_moved: p.lines_moved,
        jes_posted: p.jes_posted,
        source_inactivated: p.inactivated,
        find_by_memo: `SNAP COA merge: "${p.source}" → "${p.target}"`,
        steps: [
          `Find target "${p.target}" transactions/JEs with memo \`SNAP COA merge: "${p.source}" → "${p.target}"\``,
          `Move them back to "${p.source}" (${p.lines_moved ?? "?"} lines, $${Math.round(p.amount_swept || 0).toLocaleString()})`,
          p.inactivated ? `Reactivate "${p.source}"` : `"${p.source}" was left active — no reactivation needed`,
        ],
        // Fire this back at the same endpoint to execute (dry-run first).
        undo_payload: {
          client_link_id: clientLinkId,
          dry_run: true,
          undo: {
            source_name: p.source,
            target_name: p.target,
            memo: `SNAP COA merge: "${p.source}" → "${p.target}"`,
          },
        },
      };
    });

    const totalRetypeMoveBack = retypeReversals.reduce((s, r) => s + Math.abs(r.balance_on_twin_to_move_back), 0);
    const totalMergeMoveBack = mergeReversals.reduce((s, r) => s + Math.abs(Number(r.amount_swept) || 0), 0);

    return NextResponse.json({
      client: { id: client.id, name: client.client_name },
      dry_run: true,
      writes: "NONE — this is a plan only",
      summary: {
        retype_reversals: retypeReversals.length,
        merge_reversals: mergeReversals.length,
        total_to_move_back: Math.round((totalRetypeMoveBack + totalMergeMoveBack) * 100) / 100,
      },
      retype_reversals: retypeReversals,
      merge_reversals: mergeReversals,
      note:
        "Review this plan. To execute ONE operation: POST each row's undo_payload back to this endpoint " +
        "(dry_run:true first — shows exactly what would change; then dry_run:false to write). Verify in QBO between operations. " +
        "Undo merges FIRST (newest work), re-types LAST. The same steps can be done by hand in QuickBooks.",
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}

/** Types the line-reclass writer supports moving back. Everything else that
 *  carries the memo is reported for manual handling, never guessed at. */
const REVERSIBLE_LINE_TYPES = new Set(["Bill", "Purchase", "Expense", "VendorCredit", "Check", "CreditCardCredit"]);
const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

/**
 * Undo ONE Fix-all operation (merge or re-type) by following its memo trail:
 *   A) delete the sweep JEs whose PrivateNote carries the memo (SNAP created
 *      them — deleting restores balances exactly);
 *   B) re-point line-reclassed transactions (found on the TARGET account with
 *      the memo in PrivateNote) back to the SOURCE account;
 *   C) post-steps: reactivate the source (merge) — or for a re-type,
 *      inactivate the drained twin and give the original its clean name back.
 * Snapshots every entity to audit_log before touching it. Dry-run returns the
 * full operation list with $ amounts and writes NOTHING.
 */
async function undoOneOperation(ctx: {
  service: any;
  userId: string;
  client: any;
  clientLinkId: string;
  undo: any;
  dryRun: boolean;
  startedAt: number;
}) {
  const { service, userId, client, clientLinkId, dryRun } = ctx;
  const sourceName = String(ctx.undo.source_name || "").trim();
  const targetName = String(ctx.undo.target_name || "").trim();
  const memo = String(ctx.undo.memo || "").trim();
  const isRetype = ctx.undo.retype === true;
  if (!sourceName || !targetName || memo.length < 10) {
    return NextResponse.json({ error: "undo.source_name, undo.target_name and undo.memo are required" }, { status: 400 });
  }

  const realm = client.qbo_realm_id as string;
  const token = await getValidToken(clientLinkId, service as any);
  const accounts = await fetchAllAccountsIncludingInactive(realm, token);
  // Exact-name resolution — but QBO RENAMES an account to "<name> (deleted)"
  // when it's inactivated, so retired merge sources only match with that
  // suffix stripped (the first live dry-run failed exactly here: "Bookkeeping"
  // not found because QBO holds it as "Bookkeeping (deleted)"). If a name
  // exists both active + inactive, the source is usually the inactive one
  // (it was retired) and the target the active one.
  const stripDeleted = (n: string) => n.replace(/\s*\(deleted\)\s*$/i, "").trim();
  const findExact = (name: string, preferInactive: boolean): QBOAccount | null => {
    const want = stripDeleted(name);
    const matches = accounts.filter((a) => stripDeleted(String(a.Name)) === want);
    if (matches.length === 0) return null;
    const sorted = [...matches].sort((a, b) => {
      const ai = a.Active === false ? 0 : 1;
      const bi = b.Active === false ? 0 : 1;
      return preferInactive ? ai - bi : bi - ai;
    });
    return sorted[0];
  };
  const source = findExact(sourceName, true);
  const target = findExact(targetName, false);
  if (!source) return NextResponse.json({ error: `Source account "${sourceName}" not found (incl. inactive)` }, { status: 404 });
  if (!target) return NextResponse.json({ error: `Target account "${targetName}" not found` }, { status: 404 });

  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const today = new Date().toISOString().slice(0, 10);

  type Op = { kind: "delete_je" | "repoint_lines" | "manual"; txn_type: string; txn_id: string; date?: string; lines?: number; amount?: number; note?: string };
  const ops: Op[] = [];
  const failures: string[] = [];

  // ── A) Sweep JEs: date-windowed query, memo match client-side ──
  const jeById = new Map<string, any>();
  {
    let startPos = 1;
    for (let page = 0; page < 10; page++) {
      const q = `SELECT * FROM JournalEntry WHERE TxnDate >= '${start}' AND TxnDate <= '${today}' STARTPOSITION ${startPos} MAXRESULTS 200`;
      const data = await qboRequest<any>(realm, token, `/query?query=${encodeURIComponent(q)}`);
      const batch: any[] = data?.QueryResponse?.JournalEntry || [];
      for (const j of batch) {
        if (String(j.PrivateNote || "").includes(memo)) jeById.set(String(j.Id), j);
      }
      if (batch.length < 200) break;
      startPos += 200;
    }
  }
  for (const j of jeById.values()) {
    const debits = (j.Line || []).reduce(
      (s: number, l: any) => (l?.JournalEntryLineDetail?.PostingType === "Debit" ? s + (Number(l.Amount) || 0) : s),
      0
    );
    ops.push({ kind: "delete_je", txn_type: "JournalEntry", txn_id: String(j.Id), date: j.TxnDate, amount: r2(debits), note: String(j.PrivateNote || "").slice(0, 120) });
  }

  // ── B) Line-reclassed txns now sitting on the TARGET, memo in PrivateNote ──
  const entities = new Map<string, { type: string; id: string; ent: any }>();
  {
    const { lines } = await fetchTransactionsForAccount(realm, token, target.Id, start, today);
    const distinct = new Map<string, { type: string; id: string }>();
    for (const l of lines as any[]) {
      const key = `${l.transaction_type}:${l.transaction_id}`;
      if (!distinct.has(key)) distinct.set(key, { type: l.transaction_type, id: l.transaction_id });
    }
    if (distinct.size > MAX_TXNS_PER_UNDO) {
      return NextResponse.json(
        { error: `Target "${target.Name}" has ${distinct.size} transactions in the window — over the ${MAX_TXNS_PER_UNDO} safety cap. Narrow this one manually.` },
        { status: 400 }
      );
    }
    for (const { type, id } of distinct.values()) {
      if (type === "JournalEntry" || /journal/i.test(type)) continue; // JEs handled above
      const resource = type.replace(/[^a-zA-Z]/g, "").toLowerCase();
      try {
        const data = await qboRequest<any>(realm, token, `/${resource}/${id}?minorversion=70`);
        const entKey = Object.keys(data || {}).find((k) => k !== "time");
        const ent = entKey ? (data as any)[entKey] : null;
        if (ent && String(ent.PrivateNote || "").includes(memo)) entities.set(`${type}:${id}`, { type, id, ent });
      } catch (e: any) {
        failures.push(`fetch ${type}/${id}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }
  for (const { type, id, ent } of entities.values()) {
    const tLines = (ent.Line || []).filter(
      (l: any) => String(l?.AccountBasedExpenseLineDetail?.AccountRef?.value || "") === String(target.Id)
    );
    if (tLines.length === 0) continue;
    const amount = tLines.reduce((s: number, l: any) => s + (Number(l.Amount) || 0), 0);
    if (REVERSIBLE_LINE_TYPES.has(type)) {
      ops.push({ kind: "repoint_lines", txn_type: type, txn_id: id, date: ent.TxnDate, lines: tLines.length, amount: r2(amount) });
    } else {
      ops.push({ kind: "manual", txn_type: type, txn_id: id, date: ent.TxnDate, lines: tLines.length, amount: r2(amount), note: "type not line-reversible here — handle in QBO" });
    }
  }

  const totals = {
    jes_to_delete: ops.filter((o) => o.kind === "delete_je").length,
    txns_to_repoint: ops.filter((o) => o.kind === "repoint_lines").length,
    manual: ops.filter((o) => o.kind === "manual").length,
    amount_moved_back: r2(ops.filter((o) => o.kind !== "manual").reduce((s, o) => s + Math.abs(o.amount || 0), 0)),
  };
  // Strip BOTH suffixes QBO/the engine may have stacked on the original:
  // "Payroll Expenses (pre-retype 39) (deleted)" → "Payroll Expenses".
  const cleanName = stripDeleted(String(source.Name)).replace(PRE_RETYPE_RE, "").trim();
  const postPlanned = isRetype
    ? [`inactivate twin "${target.Name}"`, `rename "${source.Name}" → "${cleanName}"`]
    : source.Active === false
      ? [`reactivate "${source.Name}"`]
      : [];

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      client: client.client_name,
      undo: { source: source.Name, target: target.Name, memo, retype: isRetype },
      would: totals,
      post_steps: postPlanned,
      operations: ops,
      failures,
      note: "Nothing written. Re-send this exact payload with dry_run:false to execute THIS one operation.",
    });
  }

  // ── WRITE ──
  const snapshot = async (kind: string, id: string, entity: any): Promise<void> => {
    await service.from("audit_log").insert({
      event_type: "coa_revert_snapshot",
      user_id: userId,
      request_payload: { client_link_id: clientLinkId, kind, txn_id: id, entity } as any,
    } as any);
  };

  const done = { jes_deleted: 0, txns_repointed: 0, lines_moved_back: 0, amount_moved_back: 0 };
  for (const op of ops) {
    if (Date.now() - ctx.startedAt > BUDGET_MS) {
      failures.push("time budget hit — re-run the same payload to continue (already-reverted items are skipped)");
      break;
    }
    if (op.kind === "manual") continue;
    if (op.kind === "delete_je") {
      const je = jeById.get(op.txn_id);
      try {
        await snapshot("JournalEntry", op.txn_id, je);
        await qboRequest(realm, token, `/journalentry?operation=delete&minorversion=70`, {
          method: "POST",
          body: JSON.stringify({ Id: op.txn_id, SyncToken: je.SyncToken }),
        });
        done.jes_deleted++;
        done.amount_moved_back = r2(done.amount_moved_back + Math.abs(op.amount || 0));
      } catch (e: any) {
        failures.push(`delete JE ${op.txn_id}: ${String(e?.message || e).slice(0, 160)}`);
      }
      continue;
    }
    const rec = entities.get(`${op.txn_type}:${op.txn_id}`)!;
    try {
      await snapshot(op.txn_type, op.txn_id, rec.ent);
      const tLines = (rec.ent.Line || []).filter(
        (l: any) => String(l?.AccountBasedExpenseLineDetail?.AccountRef?.value || "") === String(target.Id)
      );
      const res = await reclassifyTransactionLines(realm, token, {
        txType: op.txn_type as SupportedTxType,
        txId: op.txn_id,
        lineUpdates: tLines.map((l: any) => ({
          line_id: String(l.Id),
          new_account_id: String(source.Id),
          new_account_name: String(source.Name),
        })),
        auditMemo: `SNAP COA revert: "${target.Name}" → "${source.Name}"`,
      });
      done.txns_repointed++;
      done.lines_moved_back += res.lines_applied;
      done.amount_moved_back = r2(done.amount_moved_back + Math.abs(op.amount || 0));
      for (const na of res.lines_not_applied || []) failures.push(`line ${op.txn_id}: ${(na as any).reason}`);
    } catch (e: any) {
      failures.push(`repoint ${op.txn_type}/${op.txn_id}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  // ── C) Post-steps ──
  const post: string[] = [];
  try {
    if (isRetype) {
      // Twin should be drained now — retire it FIRST so the clean name frees
      // up, then give the original its name back. QBO refuses to inactivate
      // an account holding a balance, which is the right failure mode here.
      await inactivateAccount(realm, token, String(target.Id), String((target as any).SyncToken), target);
      post.push(`inactivated twin "${target.Name}"`);
      const renamed = await renameAccount(realm, token, String(source.Id), String((source as any).SyncToken), cleanName, { currentAccount: source });
      post.push(`renamed "${source.Name}" → "${renamed.Name}"`);
    } else if (source.Active === false) {
      await reactivateAccount({ realmId: realm, accessToken: token, account: source });
      post.push(`reactivated "${source.Name}"`);
    }
  } catch (e: any) {
    failures.push(`post-step: ${String(e?.message || e).slice(0, 200)}`);
  }

  try {
    await service.from("audit_log").insert({
      event_type: "coa_audit_revert",
      user_id: userId,
      request_payload: {
        client_link_id: clientLinkId,
        client_name: client.client_name,
        source: source.Name,
        target: target.Name,
        memo,
        retype: isRetype,
        ...done,
        post_steps: post,
        failures: failures.slice(0, 30),
      } as any,
    } as any);
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    ok: failures.length === 0,
    client: client.client_name,
    undo: { source: source.Name, target: target.Name, memo, retype: isRetype },
    executed: done,
    post_steps: post,
    manual_items: ops.filter((o) => o.kind === "manual"),
    failures,
    note: "Verify this operation in QBO (P&L / account history), then fire the next row's undo_payload.",
  });
}
