import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { fetchAllAccounts } from "@/lib/qbo";
import { webSearchVendor, type AvailableAccount } from "@/lib/claude-reclass";
import { normalizeVendorForLookup } from "@/lib/vendor-knowledge";
import { getValidToken } from "@/lib/qbo-reclass";

/**
 * POST /api/reclass/[id]/web-search-chunk
 *
 * Runs web search for ALL unique vendors still needing search, in batches of
 * BATCH_SIZE processed in parallel per batch. Returns immediately; search runs
 * in the background via after(). Progress is written to error_message after
 * each batch so the UI can show "Batch X of Y".
 *
 * After all batches:
 *   - status = 'in_review'
 *   - Or 'in_review' early if skip signal fired mid-run
 *
 * Skip signal: the skip-web-search route sets error_message='[skip_web_search]'.
 * A poller inside this handler checks every 2s and aborts in-flight requests via
 * AbortController, so skip is near-instant (≤2s) rather than waiting for the
 * current batch to finish.
 */

const BATCH_SIZE = 10; // vendors per batch, processed in parallel
const TOTAL_BUDGET_MS = 10 * 60 * 1000; // 10 min hard cap; remaining vendors stay needs_review
const MAX_VENDORS = 200;

function normalizeForBankRule(name: string): string {
  return normalizeVendorForLookup(name)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, status, bookkeeper_id, client_link_id")
    .eq("id", id)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (job.status !== "web_search_paused") {
    return NextResponse.json(
      { error: `Job is not paused for web search (status: ${job.status})` },
      { status: 409 }
    );
  }

  // Mark running so the UI shows the spinner again
  await service
    .from("reclass_jobs")
    .update({ status: "executing" } as any)
    .eq("id", id);

  after(async () => {
    try {
      await runWebSearchChunk(id);
    } catch (err: any) {
      console.error(`[web-search-chunk] Failed for job ${id}:`, err);
      const svc = createServiceSupabase();
      // Count prior consecutive failures by parsing the current error_message
      // for `[web_search_error retries=N]`. After 3 failures, give up on
      // web search and hand the job to the bookkeeper as `in_review` so a
      // transient Anthropic outage can't permanently park the job — the
      // decisions made before web search are valid; the low-confidence
      // vendors just show up as needs_review.
      const { data: cur } = await svc
        .from("reclass_jobs")
        .select("error_message")
        .eq("id", id)
        .single();
      const prevMsg: string = (cur as any)?.error_message || "";
      const m = prevMsg.match(/retries=(\d+)/);
      const retries = (m ? parseInt(m[1], 10) : 0) + 1;
      const MAX_RETRIES = 3;

      if (retries >= MAX_RETRIES) {
        await svc
          .from("reclass_jobs")
          .update({
            status: "in_review",
            error_message:
              `Web search failed ${retries}× (${err.message}). Skipped web search — finish review manually; low-confidence vendors show as needs_review.`,
          } as any)
          .eq("id", id);
      } else {
        await svc
          .from("reclass_jobs")
          .update({
            status: "web_search_paused",
            error_message: `[web_search_error retries=${retries}] ${err.message} — click Continue to retry`,
          } as any)
          .eq("id", id);
      }
    }
  });

  return NextResponse.json({ started: true, job_id: id });
}

async function runWebSearchChunk(jobId: string) {
  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");

  const clientLink = (job as any).client_links;
  const threshold: number = (job as any).auto_approve_threshold || 500;

  // Fetch live QBO accounts (needed for web search result matching)
  const accessToken = await getValidToken(clientLink.id, service as any);
  const allAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);

  const isPnLType = (t: string | undefined) => {
    if (!t) return false;
    const n = t.toLowerCase().replace(/\s+/g, "");
    return ["income","otherincome","expense","otherexpense","costofgoodssold"].includes(n);
  };
  const availableAccounts: AvailableAccount[] = allAccounts
    .filter((a) => a.Active !== false && isPnLType(a.AccountType))
    .map((a) => ({
      qbo_account_id: a.Id,
      account_name: a.Name,
      account_type: a.AccountType || "",
      account_subtype: a.AccountSubType || "",
    }));

  const clientCity: string | undefined = clientLink.state_province || undefined;

  // Find vendors that haven't been web-searched yet.
  // "Already searched" marker: ai_reasoning starts with "(web search"
  const { data: pendingRows } = await service
    .from("reclassifications")
    .select("vendor_name")
    .eq("reclass_job_id", jobId)
    .in("decision", ["flagged", "needs_review"])
    .lt("ai_confidence", 0.7)
    .not("ai_reasoning", "ilike", "(web search%")
    .not("vendor_name", "is", null)
    .neq("vendor_name", "");

  // Dedupe by normalized name
  const uniqueVendors = new Map<string, string>(); // normalized → original display name
  for (const row of pendingRows || []) {
    if (!row.vendor_name) continue;
    const norm = normalizeForBankRule(row.vendor_name);
    if (norm && !uniqueVendors.has(norm)) {
      uniqueVendors.set(norm, row.vendor_name);
    }
  }

  const allVendors = [...uniqueVendors.entries()].slice(0, MAX_VENDORS);

  if (allVendors.length === 0) {
    // Nothing left to search
    await service
      .from("reclass_jobs")
      .update({ status: "in_review", error_message: null } as any)
      .eq("id", jobId);
    return;
  }

  const totalBatches = Math.ceil(allVendors.length / BATCH_SIZE);
  console.log(`[web-search-chunk ${jobId}] ${allVendors.length} vendors in ${totalBatches} batches of ${BATCH_SIZE}`);

  // Shared abort controller — fired by skip poller, by budget timer, or on error.
  const runController = new AbortController();
  let skippedByUser = false;

  const skipPoll = setInterval(async () => {
    try {
      const { data } = await service
        .from("reclass_jobs")
        .select("error_message")
        .eq("id", jobId)
        .single();
      if ((data as any)?.error_message === "[skip_web_search]") {
        skippedByUser = true;
        runController.abort(new Error("Skipped by user"));
        clearInterval(skipPoll);
      }
    } catch {}
  }, 2000);

  const newBankRules: any[] = [];
  const runStart = Date.now();

  try {
    for (let i = 0; i < allVendors.length; i += BATCH_SIZE) {
      if (runController.signal.aborted) break;
      if (Date.now() - runStart > TOTAL_BUDGET_MS) {
        console.log(`[web-search-chunk ${jobId}] Total budget exhausted at vendor ${i}/${allVendors.length}`);
        break;
      }

      const batch = allVendors.slice(i, i + BATCH_SIZE);
      const batchIdx = Math.floor(i / BATCH_SIZE) + 1;

      // Write progress BEFORE batch — UI shows movement. Conditional update so
      // the skip signal ([skip_web_search]) isn't overwritten.
      await service
        .from("reclass_jobs")
        .update({ error_message: `[web_search_progress] ${batchIdx - 1}/${totalBatches}` } as any)
        .eq("id", jobId)
        .neq("error_message", "[skip_web_search]");

      const results = await Promise.all(
        batch.map(async ([normalized, vendorName]) => {
          if (runController.signal.aborted) {
            return { normalized, vendorName, result: null };
          }
          try {
            const result = await webSearchVendor(
              { vendorName, clientCity, availableAccounts },
              { signal: runController.signal }
            );
            return { normalized, vendorName, result };
          } catch (err: any) {
            console.warn(`[web-search-chunk] "${vendorName}": ${err.message}`);
            return { normalized, vendorName, result: null };
          }
        })
      );

      for (const { normalized, vendorName, result } of results) {
        if (result && result.target_account_id && result.confidence >= 0.65) {
          // Two-pass UPDATE: set all rows to needs_review first, then upgrade
          // under-threshold rows to auto_approve. Handles negative amounts via
          // the [-threshold, threshold] range.
          await service
            .from("reclassifications")
            .update({
              to_account_id: result.target_account_id,
              to_account_name: result.target_account_name,
              ai_confidence: result.confidence,
              ai_reasoning: result.reasoning,
              decision: "needs_review",
            } as any)
            .eq("reclass_job_id", jobId)
            .eq("vendor_name", vendorName)
            .in("decision", ["flagged", "needs_review"])
            .not("ai_reasoning", "ilike", "(web search%");

          if (result.confidence >= 0.80) {
            await service
              .from("reclassifications")
              .update({ decision: "auto_approve" } as any)
              .eq("reclass_job_id", jobId)
              .eq("vendor_name", vendorName)
              .eq("ai_reasoning", result.reasoning)
              .lt("transaction_amount", threshold)
              .gt("transaction_amount", -threshold);
          }

          newBankRules.push({
            client_link_id: clientLink.id,
            vendor_pattern: normalized,
            target_account_name: result.target_account_name,
            ai_confidence: result.confidence,
            ai_reasoning: result.reasoning,
            match_type: "CONTAINS",
            status: "approved",
            requires_approval: false,
            created_by: job.bookkeeper_id,
            pushed_to_qbo: false,
          });
        } else {
          // Mark as searched (no good result) — so the vendor is excluded if
          // the bookkeeper retries the run later.
          await service
            .from("reclassifications")
            .update({ ai_reasoning: `(web search) no confident match found` } as any)
            .eq("reclass_job_id", jobId)
            .eq("vendor_name", vendorName)
            .in("decision", ["flagged", "needs_review"])
            .not("ai_reasoning", "ilike", "(web search%");
        }
      }
    }
  } finally {
    clearInterval(skipPoll);
  }

  // Cache bank rules for future jobs
  if (newBankRules.length > 0) {
    try {
      await service
        .from("bank_rules")
        .upsert(newBankRules, { onConflict: "client_link_id,vendor_pattern", ignoreDuplicates: false } as any);
    } catch (err: any) {
      console.warn(`[web-search-chunk] Bank rule cache failed:`, err.message);
    }
  }

  // Always transition to in_review when done (success, skip, budget exhausted,
  // or error). The bookkeeper handles remaining unknowns in the review screen.
  await service
    .from("reclass_jobs")
    .update({ status: "in_review", error_message: null } as any)
    .eq("id", jobId);
  console.log(`[web-search-chunk ${jobId}] DONE — moved to in_review${skippedByUser ? " (skipped)" : ""}`);
}

export const maxDuration = 800;
