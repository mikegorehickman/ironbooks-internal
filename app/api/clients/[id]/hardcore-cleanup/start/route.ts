import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import {
  fetchOpenInvoices,
  fetchUndepositedFundsPayments,
  findUndepositedFundsAccountId,
} from "@/lib/qbo-balance-sheet";
import {
  parseCsv,
  normalizeCrmRows,
  detectDuplicates,
  reconcileCrmAgainstQbo,
  type CrmSource,
} from "@/lib/hardcore-cleanup";
import { matchUFtoAR } from "@/lib/uf-ar-matcher";
import {
  findUncategorizedIncomeAccount,
  scanUncatIncome,
} from "@/lib/uncat-income-recovery";
import { parseStripePayoutsCsv } from "@/lib/stripe-payouts-csv";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Mirrors normalizeName() in lib/hardcore-cleanup.ts — kept in sync so the
 *  CRM-key → UUID map we build here resolves the same synthetic keys the
 *  reconcile engine emits. If hardcore-cleanup's normalizer ever changes,
 *  update this one too. */
function normalizeForKey(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * POST /api/clients/[id]/hardcore-cleanup/start
 *
 * Body: { crm_source: "drip_jobs"|"jobber"|"generic", crm_filename: string,
 *         csv_text: string }
 *
 * Full pipeline in one call:
 *   1. Create run row
 *   2. Parse CSV → normalized CRM jobs
 *   3. Pull open QBO invoices
 *   4. Run duplicate detection
 *   5. Persist detected items
 *   6. Mark run as 'review'
 *
 * Owner bookkeeper / admin / lead only.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if ((client as any).is_active === false) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  // CSV becomes optional. Two scan modes:
  //   - "csv"      : bookkeeper uploaded a CRM CSV. One file or many —
  //                  the body can carry `csvs: [{crm_source, csv_text,
  //                  crm_filename}, …]` for multi-source uploads (e.g.
  //                  Jobber + DripJobs together). Legacy single-file
  //                  shape (csv_text + crm_source + crm_filename) still
  //                  accepted for backwards compat.
  //   - "qbo_only" : no CSV at all. Just scan QBO directly — UF↔A/R
  //                   direct matching via matchUFtoAR. Replaces the
  //                   standalone /balance-sheet/uf-ar tool.
  // When the body sends at least one non-empty CSV we default to "csv";
  // otherwise "qbo_only". An explicit scan_mode overrides.

  // Normalize to a canonical csvs[] array regardless of which shape the
  // client sent. Both branches downstream only look at `csvs`.
  type IncomingCsv = {
    crm_source?: string;
    csv_text?: string;
    crm_filename?: string | null;
  };
  const rawCsvs: IncomingCsv[] = Array.isArray(body.csvs) ? body.csvs : [];
  // Fold the legacy single-file shape into the array form when present
  // and the client didn't also send csvs[].
  if (rawCsvs.length === 0 && typeof body.csv_text === "string" && body.csv_text.trim()) {
    rawCsvs.push({
      crm_source: body.crm_source,
      csv_text: body.csv_text,
      crm_filename: body.crm_filename,
    });
  }

  const explicitScanMode = body.scan_mode as "csv" | "qbo_only" | undefined;
  const scanMode: "csv" | "qbo_only" =
    explicitScanMode === "csv" || explicitScanMode === "qbo_only"
      ? explicitScanMode
      : rawCsvs.some((c) => (c.csv_text || "").trim())
      ? "csv"
      : "qbo_only";

  // Validate + normalize each CSV when we're in csv mode. Reject early
  // with a clear per-file message rather than letting the parser blow
  // up downstream.
  //
  // Sources:
  //   drip_jobs | jobber | generic — go through normalizeCrmRows for
  //     CRM↔QBO duplicate / missing-invoice detection.
  //   stripe — bypasses normalizeCrmRows entirely. Parsed via
  //     parseStripePayoutsCsv into stripe_payout items so the
  //     bookkeeper can reconcile bank deposits + fee expense.
  type AnyCsvSource = CrmSource | "stripe";
  const csvs: Array<{
    crm_source: AnyCsvSource;
    csv_text: string;
    crm_filename: string | null;
  }> = [];
  if (scanMode === "csv") {
    if (rawCsvs.length === 0) {
      return NextResponse.json(
        { error: "scan_mode=csv requires at least one csv. Pass csvs:[{crm_source,csv_text,crm_filename}] or legacy csv_text." },
        { status: 400 }
      );
    }
    for (let i = 0; i < rawCsvs.length; i++) {
      const c = rawCsvs[i];
      const src = (c.crm_source as AnyCsvSource | undefined) || "generic";
      if (!["drip_jobs", "jobber", "generic", "stripe"].includes(src)) {
        return NextResponse.json(
          { error: `csvs[${i}].crm_source invalid: ${src}. Expected drip_jobs | jobber | generic | stripe.` },
          { status: 400 }
        );
      }
      if (!c.csv_text || !c.csv_text.trim()) {
        return NextResponse.json(
          { error: `csvs[${i}].csv_text is empty.` },
          { status: 400 }
        );
      }
      csvs.push({
        crm_source: src,
        csv_text: c.csv_text,
        crm_filename: c.crm_filename || null,
      });
    }
  }

  // Vercel serverless function body limit is ~4.5MB. JSON-encoded CSV
  // adds overhead. Cap each individual CSV at 4MB AND total across all
  // CSVs at 4MB (the body has to fit in one request).
  const MAX_CSV_BYTES = 4 * 1024 * 1024;
  let totalBytes = 0;
  for (let i = 0; i < csvs.length; i++) {
    const bytes = Buffer.byteLength(csvs[i].csv_text, "utf8");
    if (bytes > MAX_CSV_BYTES) {
      return NextResponse.json(
        {
          error: `csvs[${i}] is too large (${Math.round(bytes / 1024 / 1024)}MB). Max 4MB per file — split or filter to a smaller date range.`,
        },
        { status: 413 }
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_CSV_BYTES) {
    return NextResponse.json(
      {
        error: `Combined CSV payload is ${Math.round(totalBytes / 1024 / 1024)}MB. Max 4MB total across all files in one upload — submit fewer files or filter them down.`,
      },
      { status: 413 }
    );
  }

  // Legacy single-field aliases for the run row write below. When
  // multiple CSVs are uploaded, crm_source becomes "multi" and the
  // joined filenames go into crm_filename so the run header reads
  // sensibly without a schema change.
  const crmSource: CrmSource | "multi" | "stripe" =
    csvs.length > 1
      ? ("multi" as any)
      : csvs.length === 1
      ? (csvs[0].crm_source as any)
      : "generic";
  const crmFilename: string | null =
    csvs.length === 0
      ? null
      : csvs.length === 1
      ? csvs[0].crm_filename
      : `${csvs.length} files: ${csvs.map((c) => c.crm_filename || `(unnamed ${c.crm_source})`).join(", ")}`;

  // Zombie cleanup
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await service
    .from("hardcore_cleanup_runs" as any)
    .update({
      status: "failed",
      error_message: "Run did not complete (server timeout). Re-upload to retry.",
    } as any)
    .eq("client_link_id", clientLinkId)
    .in("status", ["uploading", "matching"])
    .lt("created_at", fiveMinAgo);

  // Default new runs to v2 (unified 4-bucket workflow). Body can opt-in
  // to v1 for backwards-compatibility testing — every production caller
  // should leave this unset.
  const workflowVersion: 1 | 2 = body.workflow_version === 1 ? 1 : 2;

  // Create run row
  const { data: runIns, error: runErr } = await service
    .from("hardcore_cleanup_runs" as any)
    .insert({
      client_link_id: clientLinkId,
      created_by: user.id,
      status: "uploading",
      crm_source: crmSource,
      crm_filename: crmFilename,
      workflow_version: workflowVersion,
    } as any)
    .select()
    .single();
  if (runErr || !runIns) {
    return NextResponse.json(
      { error: `Failed to create run: ${runErr?.message || "unknown"}` },
      { status: 500 }
    );
  }
  const runId = (runIns as any).id as string;
  const t0 = Date.now();

  // ──────────────────────────────────────────────────────────────
  // SCAN_MODE = "qbo_only" — no CSV, direct UF↔A/R reconciliation.
  // Replaces the standalone /balance-sheet/uf-ar flow.
  // ──────────────────────────────────────────────────────────────
  if (scanMode === "qbo_only") {
    try {
      await service
        .from("hardcore_cleanup_runs" as any)
        .update({ status: "matching" } as any)
        .eq("id", runId);
      const accessToken = await getValidToken(clientLinkId, service as any);
      const realmId = (client as any).qbo_realm_id as string;
      if (!realmId) {
        throw new Error("Client has no qbo_realm_id — connect QBO first.");
      }
      const invoices = await fetchOpenInvoices(realmId, accessToken);

      // UF fetch is failure-tolerant: clients without a UF account get
      // an empty list, scan completes with 0 items, no crash.
      let ufPayments: Awaited<ReturnType<typeof fetchUndepositedFundsPayments>> = [];
      try {
        const ufAcctId = await findUndepositedFundsAccountId(realmId, accessToken);
        if (ufAcctId) {
          ufPayments = await fetchUndepositedFundsPayments(realmId, accessToken, ufAcctId);
        }
      } catch (err: any) {
        console.warn(
          `[hardcore-start ${runId}] UF fetch failed (qbo_only mode): ${err?.message}`
        );
      }

      // Persist UF payment snapshots so the review UI is stable + the
      // resolution UI can show full payment context. Same shape the
      // CSV flow uses.
      const ufRowIdByQboId = new Map<string, string>();
      if (ufPayments.length > 0) {
        const ufInsertRows = ufPayments.map((p) => ({
          run_id: runId,
          qbo_payment_id: p.qbo_payment_id,
          qbo_object_type: "Payment",
          qbo_customer_id: p.customer_id,
          qbo_customer_name: p.customer_name,
          payment_date: p.date,
          amount: p.amount,
          memo: p.memo,
          existing_linked_txns: null,
        }));
        const BATCH = 200;
        for (let i = 0; i < ufInsertRows.length; i += BATCH) {
          const { data: returned, error: ue } = await service
            .from("hardcore_cleanup_uf_payments" as any)
            .insert(ufInsertRows.slice(i, i + BATCH) as any)
            .select("id, qbo_payment_id");
          if (ue) throw new Error(`UF payments insert failed: ${ue.message}`);
          for (const row of (returned as any[]) || []) {
            ufRowIdByQboId.set(row.qbo_payment_id, row.id);
          }
        }
      }

      // Run UF↔A/R matcher. Returns one MatchResult per UF payment.
      const matches = matchUFtoAR(ufPayments, invoices);

      // Map MatchResult → hardcore_cleanup_items row.
      // - exact_invoice_number / high_confidence → uf_to_ar_match,
      //   resolution=apply_payment (auto-resolved so the bookkeeper can
      //   bulk-finalize without picking).
      // - low_confidence → uf_to_ar_match, resolution=pending (needs
      //   bookkeeper to pick from candidate list).
      // - unmatched → unmatched_uf, resolution=pending.
      const itemsToInsert: any[] = [];
      for (const m of matches) {
        const ufRowId = ufRowIdByQboId.get(m.payment.qbo_payment_id) || null;
        const pickedInv = m.proposed[0] || null;
        const isConfident =
          m.kind === "exact_invoice_number" || m.kind === "high_confidence";
        if (isConfident && pickedInv) {
          itemsToInsert.push({
            run_id: runId,
            client_link_id: clientLinkId,
            item_type: "uf_to_ar_match",
            qbo_invoice_id: pickedInv.qbo_invoice_id,
            qbo_invoice_doc_number: pickedInv.doc_number,
            qbo_invoice_date: pickedInv.txn_date,
            qbo_invoice_amount: pickedInv.total_amount,
            qbo_invoice_balance: pickedInv.balance,
            qbo_customer_name: pickedInv.customer_name,
            qbo_customer_id: pickedInv.customer_id,
            uf_payment_id: m.payment.qbo_payment_id,
            uf_customer_name: m.payment.customer_name,
            uf_payment_amount: m.payment.amount,
            uf_payment_date: m.payment.date,
            uf_row_id: ufRowId,
            confidence: m.confidence,
            reasoning: m.reasoning,
            // Auto-resolve confident matches: bookkeeper hits Finalize
            // and the existing applyPaymentToInvoices path runs.
            resolution: "apply_payment",
            resolution_target_account_id: null,
            resolution_target_account_name: null,
          });
        } else if (m.kind === "low_confidence" && pickedInv) {
          itemsToInsert.push({
            run_id: runId,
            client_link_id: clientLinkId,
            item_type: "uf_to_ar_match",
            qbo_invoice_id: pickedInv.qbo_invoice_id,
            qbo_invoice_doc_number: pickedInv.doc_number,
            qbo_invoice_date: pickedInv.txn_date,
            qbo_invoice_amount: pickedInv.total_amount,
            qbo_invoice_balance: pickedInv.balance,
            qbo_customer_name: pickedInv.customer_name,
            qbo_customer_id: pickedInv.customer_id,
            uf_payment_id: m.payment.qbo_payment_id,
            uf_customer_name: m.payment.customer_name,
            uf_payment_amount: m.payment.amount,
            uf_payment_date: m.payment.date,
            uf_row_id: ufRowId,
            confidence: m.confidence,
            reasoning: m.reasoning,
            // Bookkeeper must pick — finalize will skip pending items.
            resolution: "pending",
            resolution_target_account_id: null,
            resolution_target_account_name: null,
          });
        } else {
          // unmatched — no A/R candidate worth surfacing
          itemsToInsert.push({
            run_id: runId,
            client_link_id: clientLinkId,
            item_type: "unmatched_uf",
            uf_payment_id: m.payment.qbo_payment_id,
            uf_customer_name: m.payment.customer_name,
            uf_payment_amount: m.payment.amount,
            uf_payment_date: m.payment.date,
            uf_row_id: ufRowId,
            confidence: m.confidence,
            reasoning: m.reasoning,
            resolution: "pending",
          });
        }
      }

      if (itemsToInsert.length > 0) {
        const BATCH = 200;
        for (let i = 0; i < itemsToInsert.length; i += BATCH) {
          const { error: ie } = await service
            .from("hardcore_cleanup_items" as any)
            .insert(itemsToInsert.slice(i, i + BATCH) as any);
          if (ie) throw new Error(`Items insert failed: ${ie.message}`);
        }
      }

      const confidentCount = matches.filter(
        (m) => m.kind === "exact_invoice_number" || m.kind === "high_confidence"
      ).length;
      const lowConfCount = matches.filter((m) => m.kind === "low_confidence").length;
      const unmatchedCount = matches.filter((m) => m.kind === "unmatched").length;
      const totalConfidentDollars = matches
        .filter((m) => m.kind === "exact_invoice_number" || m.kind === "high_confidence")
        .reduce((s, m) => s + Math.abs(m.payment.amount), 0);

      // ── Uncategorized Income scan ────────────────────────────────────
      // Consolidates the standalone /uncat-income-recovery tool. Pulls
      // every Deposit/JE Line that posts to an "Uncategorized Income"
      // account, tries to match each to an open invoice via
      // classifyDeterministic (same logic the standalone tool uses).
      // Hits become hardcore_cleanup_items.item_type = 'uncat_income'.
      // Fail-soft: clients with no Uncat Income account get a no-op +
      // a note in finalize_results; the UF results above still ship.
      let uncatItemsCount = 0;
      let uncatTotalDollars = 0;
      let uncatScanNote: string | null = null;
      try {
        const uncatAccount = await findUncategorizedIncomeAccount(
          realmId,
          accessToken
        );
        if (!uncatAccount) {
          uncatScanNote = "No Uncategorized Income account in this QBO — skipped.";
        } else {
          const uncatResult = await scanUncatIncome(realmId, accessToken, uncatAccount);
          const uncatItemsToInsert: any[] = uncatResult.items.map((it) => {
            const exact = it.classification === "exact_single";
            const candidate = it.candidates[0] || null;
            return {
              run_id: runId,
              client_link_id: clientLinkId,
              item_type: "uncat_income",
              // Re-purpose qbo_invoice_* columns to hold the matched
              // candidate invoice (when classification != no_match)
              // so the existing review UI can render the suggestion.
              qbo_invoice_id: candidate?.qbo_invoice_id || it.qbo_txn_id,
              qbo_invoice_doc_number: candidate?.doc_number || null,
              qbo_invoice_date: candidate?.txn_date || it.txn_date,
              qbo_invoice_amount: candidate?.balance || it.amount,
              qbo_invoice_balance: candidate?.balance || it.amount,
              qbo_customer_name:
                candidate?.customer_name || it.customer_name || null,
              qbo_customer_id:
                candidate?.customer_qbo_id || it.customer_qbo_id || null,
              qbo_invoice_memo: it.description || it.private_note,
              confidence:
                it.classification === "exact_single"
                  ? 0.95
                  : it.classification === "exact_multi"
                  ? 0.6
                  : 0.3,
              reasoning: buildUncatIncomeReasoning(it),
              // Conservative v1 resolution: never auto-apply. Bookkeeper
              // reviews each and picks manual / keep / je_writeoff. The
              // v2 commit will wire a `recategorize` resolution that
              // does the sparse update on the Deposit/JE Line.
              resolution: "pending" as const,
            };
          });
          if (uncatItemsToInsert.length > 0) {
            const BATCH = 200;
            for (let i = 0; i < uncatItemsToInsert.length; i += BATCH) {
              const { error: ie } = await service
                .from("hardcore_cleanup_items" as any)
                .insert(uncatItemsToInsert.slice(i, i + BATCH) as any);
              if (ie) throw new Error(`Uncat income items insert failed: ${ie.message}`);
            }
          }
          uncatItemsCount = uncatResult.items.length;
          uncatTotalDollars = uncatResult.total_uncat_amount;
        }
      } catch (err: any) {
        // Don't fail the run if uncat-income scan errors — keep the UF
        // results. Record the error in finalize_results for diagnosis.
        uncatScanNote = `uncat-income scan failed: ${err?.message || String(err)}`;
        console.warn(
          `[hardcore-start ${runId}] uncat-income scan failed:`,
          err?.message
        );
      }

      await service
        .from("hardcore_cleanup_runs" as any)
        .update({
          status: "review",
          duplicates_detected: matches.length + uncatItemsCount,
          finalize_results: {
            scan_mode: "qbo_only",
            uf_payments_scanned: ufPayments.length,
            open_invoices_scanned: invoices.length,
            confident_matches: confidentCount,
            low_confidence_matches: lowConfCount,
            unmatched: unmatchedCount,
            confident_apply_dollars: Math.round(totalConfidentDollars * 100) / 100,
            uncat_income_items: uncatItemsCount,
            uncat_income_dollars: Math.round(uncatTotalDollars * 100) / 100,
            uncat_income_note: uncatScanNote,
            duration_ms: Date.now() - t0,
          },
        } as any)
        .eq("id", runId);

      return NextResponse.json({
        ok: true,
        run_id: runId,
        scan_mode: "qbo_only",
        uf_payments_scanned: ufPayments.length,
        open_invoices_scanned: invoices.length,
        confident_matches: confidentCount,
        low_confidence_matches: lowConfCount,
        unmatched: unmatchedCount,
        confident_apply_dollars: Math.round(totalConfidentDollars * 100) / 100,
        uncat_income_items: uncatItemsCount,
        uncat_income_dollars: Math.round(uncatTotalDollars * 100) / 100,
        uncat_income_note: uncatScanNote,
        review_url: `/balance-sheet/${clientLinkId}/hardcore-cleanup?run_id=${runId}`,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      await service
        .from("hardcore_cleanup_runs" as any)
        .update({
          status: "failed",
          error_message: msg.slice(0, 1000),
        } as any)
        .eq("id", runId);
      return NextResponse.json(
        { error: `qbo_only scan failed: ${msg}`, run_id: runId },
        { status: 500 }
      );
    }
  }

  // ──────────────────────────────────────────────────────────────
  // SCAN_MODE = "csv" — existing CRM CSV upload flow.
  // ──────────────────────────────────────────────────────────────
  try {
    // 1. Parse EVERY CSV and concatenate the results. Each CSV uses its
    //    own crm_source so column mapping is correct per file (Jobber
    //    has "Job #" / DripJobs has "Invoice ID" etc.). The matcher
    //    runs once across the combined crm_jobs list — so a Jobber
    //    Invoice 1234 and a DripJobs Proposal Name #1234 both go
    //    through DocNumber matching together.
    type ParsedSlice = { source: CrmSource; jobs: ReturnType<typeof normalizeCrmRows> };
    const slices: ParsedSlice[] = [];
    // Stripe payouts get pulled aside from CRM jobs — they go through a
    // completely different parser + persist as item_type=stripe_payout
    // (not a CRM job at all). Collected here so they can be inserted
    // after the CRM detection finishes.
    type StripeSlice = {
      payouts: ReturnType<typeof parseStripePayoutsCsv>["payouts"];
      filename: string | null;
      warnings: string[];
    };
    const stripeSlices: StripeSlice[] = [];
    for (let i = 0; i < csvs.length; i++) {
      const c = csvs[i];
      if (c.crm_source === "stripe") {
        const result = parseStripePayoutsCsv(c.csv_text);
        if (result.payouts.length === 0) {
          throw new Error(
            `csvs[${i}] (${c.crm_filename || "stripe"}): no Stripe payouts parsed. ` +
              (result.warnings[0] || "Check the export — looks like a Payouts or Balance Transactions CSV is expected.")
          );
        }
        stripeSlices.push({
          payouts: result.payouts,
          filename: c.crm_filename,
          warnings: result.warnings,
        });
        if (result.warnings.length > 0) {
          console.warn(
            `[hardcore-start ${runId}] stripe parse warnings: ${result.warnings.join(" | ")}`
          );
        }
        continue;
      }
      const rawRows = parseCsv(c.csv_text);
      if (rawRows.length === 0) {
        throw new Error(
          `csvs[${i}] (${c.crm_filename || c.crm_source}): had no data rows. Check the file.`
        );
      }
      const jobs = normalizeCrmRows(rawRows, c.crm_source as CrmSource);
      if (jobs.length === 0) {
        const detectedHeaders = Object.keys(rawRows[0] || {});
        const sample = rawRows.slice(0, 3).map((r) => {
          const filled = Object.entries(r).filter(([, v]) => v && String(v).trim());
          return filled.map(([k, v]) => `${k}="${String(v).slice(0, 40)}"`).join(", ");
        });
        throw new Error(
          `csvs[${i}] (${c.crm_filename || c.crm_source}) parsed ${rawRows.length} rows but none had a recognizable customer name column. ` +
          `Detected headers: ${detectedHeaders.length > 0 ? detectedHeaders.map((h) => `"${h}"`).join(", ") : "(none)"}. ` +
          `Expected one of: "Customer", "Customer Name", "Client", "Client Name", "Name", "Source Name", "Customer:Job". ` +
          `Sample of first row: ${sample[0] || "(empty)"}. ` +
          `If your customer column has a different header, send Mike the header name to add it to the alias list.`
        );
      }
      slices.push({ source: c.crm_source as CrmSource, jobs });
    }
    // Flatten — engine doesn't currently care which source each job
    // came from. (If we ever want per-source telemetry we'd carry that
    // through on the persisted rows; not needed for matching today.)
    const crmJobs = slices.flatMap((s) => s.jobs);
    const totalStripePayouts = stripeSlices.reduce((s, x) => s + x.payouts.length, 0);
    if (crmJobs.length === 0 && totalStripePayouts === 0) {
      throw new Error("No CRM jobs or Stripe payouts parsed across all files. Nothing to match.");
    }
    console.log(
      `[hardcore-start ${runId}] Parsed ${crmJobs.length} CRM jobs + ${totalStripePayouts} Stripe payouts across ${csvs.length} file(s): ` +
      `${slices.map((s) => `${s.source}=${s.jobs.length}`).join(", ")}` +
      (stripeSlices.length > 0 ? `, stripe=${totalStripePayouts}` : "")
    );

    // Persist Stripe payouts as hardcore_cleanup_items immediately. They
    // don't go through the CRM matcher — they're informational/manual
    // reconciliation today. v2 will add automatic matching against the
    // UF + bank-deposit pool.
    if (totalStripePayouts > 0) {
      const stripeRows: any[] = [];
      for (const slice of stripeSlices) {
        for (const p of slice.payouts) {
          stripeRows.push({
            run_id: runId,
            client_link_id: clientLinkId,
            item_type: "stripe_payout",
            // Re-use qbo_invoice_* columns to surface payout data in the
            // existing review UI without a schema change.
            qbo_invoice_id: p.stripe_payout_id || `stripe:${p.arrival_date}:${p.amount}`,
            qbo_invoice_doc_number: p.stripe_payout_id || null,
            qbo_invoice_date: p.arrival_date,
            qbo_invoice_amount: p.amount,
            qbo_invoice_balance: p.net,
            qbo_invoice_memo: p.description || null,
            confidence: 1.0,
            reasoning:
              `Stripe payout ${p.stripe_payout_id || "(no id)"} ` +
              `$${p.amount.toFixed(2)} gross` +
              (p.fee != null ? ` − $${p.fee.toFixed(2)} fee` : "") +
              ` = $${p.net.toFixed(2)} net, arrived ${p.arrival_date || "(no date)"}. ` +
              `Match this to a QBO bank deposit + confirm the Stripe fee is booked as an expense. ` +
              `From: ${slice.filename || "stripe.csv"}.`,
            resolution: "pending" as const,
          });
        }
      }
      const BATCH = 200;
      for (let i = 0; i < stripeRows.length; i += BATCH) {
        const { error: se } = await service
          .from("hardcore_cleanup_items" as any)
          .insert(stripeRows.slice(i, i + BATCH) as any);
        if (se) throw new Error(`Stripe payout items insert failed: ${se.message}`);
      }
    }

    if (crmJobs.length === 0) {
      // Stripe-only upload — short-circuit and finalize the run here.
      await service
        .from("hardcore_cleanup_runs" as any)
        .update({
          status: "review",
          duplicates_detected: totalStripePayouts,
          finalize_results: {
            scan_mode: "csv",
            stripe_payouts: totalStripePayouts,
            crm_jobs: 0,
            duration_ms: Date.now() - t0,
          },
        } as any)
        .eq("id", runId);
      return NextResponse.json({
        ok: true,
        run_id: runId,
        scan_mode: "csv",
        stripe_payouts: totalStripePayouts,
        crm_jobs: 0,
        review_url: `/balance-sheet/${clientLinkId}/hardcore-cleanup?run_id=${runId}`,
      });
    }

    // Persist CRM jobs AND capture their IDs in input order. Using
    // `.insert(arr).select("id")` returns rows in the same order they
    // were inserted — this is more reliable than re-querying by
    // created_at, which can race when batch inserts share a microsecond
    // timestamp.
    const BATCH = 200;
    const crmJobInsertRows = crmJobs.map((j) => ({
      run_id: runId,
      crm_job_id: j.crm_job_id,
      external_invoice_id: j.external_invoice_id,
      job_name: j.job_name,
      customer_name: j.customer_name,
      job_status: j.job_status,
      amount: j.amount,
      job_date: j.job_date,
      raw_row: j.raw_row,
    }));
    const persistedJobIds: string[] = [];
    for (let i = 0; i < crmJobInsertRows.length; i += BATCH) {
      const { data: returned, error: ce } = await service
        .from("hardcore_cleanup_crm_jobs" as any)
        .insert(crmJobInsertRows.slice(i, i + BATCH) as any)
        .select("id");
      if (ce) throw new Error(`CRM jobs insert failed: ${ce.message}`);
      for (const r of (returned as any[]) || []) {
        persistedJobIds.push(r.id);
      }
    }
    if (persistedJobIds.length !== crmJobs.length) {
      throw new Error(
        `CRM job persist returned ${persistedJobIds.length} IDs, expected ${crmJobs.length} — refusing to proceed with mismatched indices`
      );
    }

    // 2. Fetch QBO open invoices + (V2) UF deposits
    await service
      .from("hardcore_cleanup_runs" as any)
      .update({ status: "matching" } as any)
      .eq("id", runId);
    const accessToken = await getValidToken(clientLinkId, service as any);
    const realmId = (client as any).qbo_realm_id as string;
    const invoices = await fetchOpenInvoices(realmId, accessToken);

    // V2: also pull Undeposited Funds deposits. V1 skips this (kept narrow
    // for backwards-compat). UF fetch is failure-tolerant — if the client
    // has no UF account configured we surface "0 UF payments" rather than
    // crashing the whole run.
    let ufPayments: Awaited<ReturnType<typeof fetchUndepositedFundsPayments>> = [];
    if (workflowVersion === 2) {
      try {
        const ufAcctId = await findUndepositedFundsAccountId(realmId, accessToken);
        if (ufAcctId) {
          ufPayments = await fetchUndepositedFundsPayments(realmId, accessToken, ufAcctId);
        } else {
          console.warn(
            `[hardcore-start ${runId}] No Undeposited Funds account found in QBO — UF buckets will be empty.`
          );
        }
      } catch (err: any) {
        console.warn(
          `[hardcore-start ${runId}] UF fetch failed (continuing without UF data): ${err?.message}`
        );
      }
    }

    // 3. Run reconciliation
    // V1: detectDuplicates only (legacy path, kept for Clean Cut etc).
    // V2: full reconcileCrmAgainstQbo (4 buckets + uf_match informational).
    const detection =
      workflowVersion === 2
        ? reconcileCrmAgainstQbo({ crmJobs, qboInvoices: invoices, ufPayments })
        : { ...detectDuplicates({ crmJobs, qboInvoices: invoices }), missingInvoices: [], ufMatches: [], unmatchedJobs: [], unmatchedUf: [] };

    // 4a. Persist UF payments snapshot (V2 only). Each row backs one or
    // more hardcore_cleanup_items so the review UI is stable even if QBO
    // state shifts between scan and finalize. We index by qbo_payment_id
    // so the item-insert step can resolve UF rows back to their UUIDs.
    const ufRowIdByQboId = new Map<string, string>();
    if (workflowVersion === 2 && ufPayments.length > 0) {
      const ufInsertRows = ufPayments.map((p) => ({
        run_id: runId,
        qbo_payment_id: p.qbo_payment_id,
        qbo_object_type: "Payment", // fetchUndepositedFundsPayments only returns Payments today
        qbo_customer_id: p.customer_id,
        qbo_customer_name: p.customer_name,
        payment_date: p.date,
        amount: p.amount,
        memo: p.memo,
        existing_linked_txns: null, // V2 doesn't surface this yet — defer until applyPayment lands
      }));
      for (let i = 0; i < ufInsertRows.length; i += BATCH) {
        const { data: returned, error: ue } = await service
          .from("hardcore_cleanup_uf_payments" as any)
          .insert(ufInsertRows.slice(i, i + BATCH) as any)
          .select("id, qbo_payment_id");
        if (ue) throw new Error(`UF payments insert failed: ${ue.message}`);
        for (const row of (returned as any[]) || []) {
          ufRowIdByQboId.set(row.qbo_payment_id, row.id);
        }
      }
    }

    // 4b. Persist items — duplicates (V1 + V2) plus 4 new buckets (V2 only).
    //
    // We need a CRM-job-key → UUID map so the engine's string keys
    // (`crm_job_id` or synthetic) resolve back to the rows we just inserted.
    // Mirror the engine's jobIdKey() logic exactly.
    const crmKeyToUuid = new Map<string, string>();
    for (let i = 0; i < crmJobs.length; i++) {
      const j = crmJobs[i];
      const key = j.crm_job_id || `synth:${normalizeForKey(j.customer_name)}:${j.amount}:${j.job_date}`;
      crmKeyToUuid.set(key, persistedJobIds[i]);
      // Also store the "name:" fallback the engine uses when crm_job_id is missing
      if (!j.crm_job_id && j.customer_name) {
        crmKeyToUuid.set(`name:${j.customer_name}`, persistedJobIds[i]);
      }
    }

    const itemRows: any[] = [];

    // Duplicates (both versions)
    for (const d of detection.duplicates) {
      itemRows.push({
        run_id: runId,
        client_link_id: clientLinkId,
        item_type: "duplicate_invoice",
        qbo_invoice_id: d.qbo_invoice.qbo_invoice_id,
        qbo_invoice_doc_number: d.qbo_invoice.doc_number,
        qbo_invoice_date: d.qbo_invoice.txn_date,
        qbo_invoice_amount: d.qbo_invoice.total_amount,
        qbo_invoice_balance: d.qbo_invoice.balance,
        qbo_customer_id: d.qbo_invoice.customer_id,
        qbo_customer_name: d.qbo_invoice.customer_name,
        qbo_invoice_memo: null,
        matched_crm_job_id:
          d.matched_crm_job_index != null && persistedJobIds[d.matched_crm_job_index]
            ? persistedJobIds[d.matched_crm_job_index]
            : null,
        surviving_qbo_invoice_id: d.surviving_qbo_invoice.qbo_invoice_id,
        surviving_qbo_invoice_doc_number: d.surviving_qbo_invoice.doc_number,
        confidence: d.confidence,
        reasoning: d.reasoning,
        resolution: "pending",
      });
    }

    // V2 buckets
    if (workflowVersion === 2) {
      // missing_invoice — CRM job, no QBO invoice
      for (const m of detection.missingInvoices) {
        itemRows.push({
          run_id: runId,
          client_link_id: clientLinkId,
          item_type: "missing_invoice",
          qbo_invoice_id: null,
          qbo_customer_name: m.customer_name,
          matched_crm_job_id: crmKeyToUuid.get(m.crm_job_id) || null,
          confidence: 0.85,
          reasoning: m.reasoning,
          resolution: "pending",
          uf_payment_amount: m.amount,
        });
      }
      // uf_match — informational: 1:1 or 1:N reconciled match
      for (const m of detection.ufMatches) {
        const ufRowId = ufRowIdByQboId.get(m.uf_payment_id) || null;
        const matchedCrmUuids = m.crm_job_ids
          .map((k) => crmKeyToUuid.get(k))
          .filter((x): x is string => !!x);
        itemRows.push({
          run_id: runId,
          client_link_id: clientLinkId,
          item_type: "uf_match",
          qbo_invoice_id: null,
          uf_payment_id: m.uf_payment_id,
          uf_payment_date: m.uf_payment_date,
          uf_payment_amount: m.uf_payment_amount,
          uf_customer_name: m.uf_customer_name,
          // Set matched_crm_job_id to the FIRST job (1:1 path); crm_job_ids
          // array carries the full N for 1:N bulk deposits.
          matched_crm_job_id: matchedCrmUuids[0] || null,
          crm_job_ids: matchedCrmUuids.length > 0 ? matchedCrmUuids : null,
          confidence: m.confidence,
          reasoning: m.reasoning,
          // Bulk matches start as 'pending' so the bookkeeper must confirm.
          // 1:1 matches default to 'apply_payment' since high-confidence.
          resolution: m.crm_job_ids.length === 1 ? "apply_payment" : "pending",
        });
        void ufRowId; // referenced via uf_payment_id; row.id reserved for future joins
      }
      // unmatched_job — CRM job, no UF deposit
      for (const j of detection.unmatchedJobs) {
        itemRows.push({
          run_id: runId,
          client_link_id: clientLinkId,
          item_type: "unmatched_job",
          qbo_invoice_id: null,
          qbo_customer_name: j.customer_name,
          matched_crm_job_id: crmKeyToUuid.get(j.crm_job_id) || null,
          confidence: 0.6,
          reasoning: j.reasoning,
          resolution: "pending",
          uf_payment_amount: j.amount,
        });
      }
      // unmatched_uf — UF deposit, no CRM job
      for (const u of detection.unmatchedUf) {
        itemRows.push({
          run_id: runId,
          client_link_id: clientLinkId,
          item_type: "unmatched_uf",
          qbo_invoice_id: null,
          uf_payment_id: u.uf_payment_id,
          uf_payment_amount: u.uf_payment_amount,
          uf_payment_date: u.uf_payment_date,
          uf_customer_name: u.uf_customer_name,
          qbo_invoice_memo: u.memo,
          confidence: 0.5,
          reasoning: u.reasoning,
          resolution: "pending",
        });
      }
    }

    if (itemRows.length > 0) {
      for (let i = 0; i < itemRows.length; i += BATCH) {
        const { error: ie } = await service
          .from("hardcore_cleanup_items" as any)
          .insert(itemRows.slice(i, i + BATCH) as any);
        if (ie) throw new Error(`Items insert failed: ${ie.message}`);
      }
    }

    const totalPhantom = detection.duplicates.reduce(
      (s, d) => s + (d.qbo_invoice.balance ?? d.qbo_invoice.total_amount ?? 0),
      0
    );

    await service
      .from("hardcore_cleanup_runs" as any)
      .update({
        status: "review",
        crm_jobs_uploaded: crmJobs.length,
        qbo_invoices_scanned: invoices.length,
        duplicates_detected: detection.duplicates.length,
        total_phantom_ar: Math.round(totalPhantom * 100) / 100,
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", runId);

    return NextResponse.json({
      ok: true,
      run_id: runId,
      workflow_version: workflowVersion,
      crm_jobs_uploaded: crmJobs.length,
      qbo_invoices_scanned: invoices.length,
      uf_payments_scanned: ufPayments.length,
      duplicates_detected: detection.duplicates.length,
      missing_invoices_detected: workflowVersion === 2 ? detection.missingInvoices.length : 0,
      uf_matches_detected: workflowVersion === 2 ? detection.ufMatches.length : 0,
      unmatched_jobs_detected: workflowVersion === 2 ? detection.unmatchedJobs.length : 0,
      unmatched_uf_detected: workflowVersion === 2 ? detection.unmatchedUf.length : 0,
      total_phantom_ar: Math.round(totalPhantom * 100) / 100,
      customer_summary: detection.customerSummary,
    });
  } catch (err: any) {
    await service
      .from("hardcore_cleanup_runs" as any)
      .update({
        status: "failed",
        error_message: err?.message || String(err),
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", runId);
    return NextResponse.json(
      { error: err?.message || String(err) },
      { status: 500 }
    );
  }
}

/**
 * Bookkeeper-readable reasoning for an uncat-income item. Picks the
 * tightest description the classifier can produce so the review row
 * tells the bookkeeper exactly what to do without opening QBO.
 */
function buildUncatIncomeReasoning(it: {
  classification: "exact_single" | "exact_multi" | "ai_inferred" | "no_match";
  qbo_txn_type: string;
  txn_date: string;
  amount: number;
  description: string;
  private_note: string;
  customer_name: string | null;
  candidates: Array<{
    qbo_invoice_id: string;
    doc_number: string | null;
    customer_name: string | null;
    balance: number;
  }>;
}): string {
  const cust =
    it.customer_name ||
    it.candidates[0]?.customer_name ||
    "(no customer on txn)";
  const amt = `$${Math.abs(it.amount).toFixed(2)}`;
  const memo =
    (it.description || it.private_note || "").slice(0, 120).trim() || "(no memo)";
  if (it.classification === "exact_single") {
    const c = it.candidates[0];
    return (
      `${it.qbo_txn_type} ${amt} on ${it.txn_date} for ${cust} hit Uncategorized Income. ` +
      `Open invoice #${c?.doc_number || c?.qbo_invoice_id} for the same amount is the likely target — ` +
      `recategorize the deposit line to A/R + Apply to invoice in QBO. Memo: "${memo}".`
    );
  }
  if (it.classification === "exact_multi") {
    return (
      `${it.qbo_txn_type} ${amt} on ${it.txn_date} for ${cust} hit Uncategorized Income. ` +
      `${it.candidates.length} open invoices for this customer share the amount — pick the right one in QBO and apply. Memo: "${memo}".`
    );
  }
  if (it.classification === "ai_inferred") {
    return (
      `${it.qbo_txn_type} ${amt} on ${it.txn_date} hit Uncategorized Income with no customer on the line. ` +
      `AI inferred this might be from ${cust} — confirm before applying. Memo: "${memo}".`
    );
  }
  return (
    `${it.qbo_txn_type} ${amt} on ${it.txn_date} hit Uncategorized Income — no open invoice matches. ` +
    `Either recategorize to the correct revenue account (Painting Revenue, etc.) or apply to a paid-already invoice in QBO. Memo: "${memo}".`
  );
}
