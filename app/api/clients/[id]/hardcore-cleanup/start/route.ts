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
  const crmSource = body.crm_source as CrmSource;
  const crmFilename = body.crm_filename || null;
  const csvText = body.csv_text || "";
  if (!["drip_jobs", "jobber", "generic"].includes(crmSource)) {
    return NextResponse.json({ error: "Invalid crm_source" }, { status: 400 });
  }
  if (!csvText.trim()) {
    return NextResponse.json({ error: "csv_text is required" }, { status: 400 });
  }
  // Vercel serverless function body limit is ~4.5MB. JSON-encoded CSV
  // adds overhead. Cap at 4MB raw to keep us well under.
  const MAX_CSV_BYTES = 4 * 1024 * 1024;
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    return NextResponse.json(
      {
        error:
          `CSV is too large (${Math.round(Buffer.byteLength(csvText, "utf8") / 1024 / 1024)}MB). ` +
          `Max 4MB — split the export or filter to a smaller date range.`,
      },
      { status: 413 }
    );
  }

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

  try {
    // 1. Parse CSV
    const rawRows = parseCsv(csvText);
    if (rawRows.length === 0) {
      throw new Error("CSV had no data rows. Check the file and try again.");
    }
    const crmJobs = normalizeCrmRows(rawRows, crmSource);
    if (crmJobs.length === 0) {
      // Surface the actual headers we found PLUS a sample of the first
      // populated row's data so Mike/Lisa can see exactly what we're
      // parsing. The generic "expected Customer/Client/Name" message left
      // them guessing — this one shows reality.
      const detectedHeaders = Object.keys(rawRows[0] || {});
      const sample = rawRows.slice(0, 3).map((r) => {
        const filled = Object.entries(r).filter(([, v]) => v && String(v).trim());
        return filled.map(([k, v]) => `${k}="${String(v).slice(0, 40)}"`).join(", ");
      });
      throw new Error(
        `CSV parsed ${rawRows.length} rows but none had a recognizable customer name column. ` +
        `Detected headers: ${detectedHeaders.length > 0 ? detectedHeaders.map((h) => `"${h}"`).join(", ") : "(none)"}. ` +
        `Expected one of: "Customer", "Customer Name", "Client", "Client Name", "Name", "Source Name", "Customer:Job". ` +
        `Sample of first row: ${sample[0] || "(empty)"}. ` +
        `If your customer column has a different header, send Mike the header name to add it to the alias list.`
      );
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
