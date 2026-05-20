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
 * Runs the next chunk of web searches (up to CHUNK_SIZE unique vendors) for a
 * job that is in 'web_search_paused' state. Returns immediately; search runs
 * in the background via after().
 *
 * After the chunk completes:
 *   - More vendors remain → status stays 'web_search_paused'
 *   - All vendors done OR skip was requested → status = 'in_review'
 *   - Error → status returns to 'web_search_paused' so the bookkeeper can retry
 *
 * Skip signal: the skip-web-search route sets error_message='[skip_web_search]'.
 * A poller inside this handler checks every 2s and aborts in-flight requests via
 * AbortController, so skip is near-instant (≤2s) rather than waiting for the
 * current batch to finish.
 */

const CHUNK_SIZE = 20; // vendors per Continue click
const CONCURRENCY = 5; // parallel searches within a chunk

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
      await svc
        .from("reclass_jobs")
        .update({
          status: "web_search_paused",
          error_message: `[web_search_error] ${err.message} — click Continue to retry`,
        } as any)
        .eq("id", id);
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

  const allRemainingCount = uniqueVendors.size;
  const vendorEntries = [...uniqueVendors.entries()].slice(0, CHUNK_SIZE);

  if (vendorEntries.length === 0) {
    // Nothing left to search
    await service
      .from("reclass_jobs")
      .update({ status: "in_review", error_message: null } as any)
      .eq("id", jobId);
    return;
  }

  // Shared abort controller for the whole chunk.
  // The skip poller fires it when the bookkeeper clicks Skip.
  const chunkController = new AbortController();
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
        chunkController.abort(new Error("Skipped by user"));
        clearInterval(skipPoll);
      }
    } catch {}
  }, 2000);

  const newBankRules: any[] = [];

  try {
    for (let i = 0; i < vendorEntries.length; i += CONCURRENCY) {
      if (chunkController.signal.aborted) break;

      const batch = vendorEntries.slice(i, i + CONCURRENCY);
      const batchNames = batch.map(([, name]) => name);

      // Write live progress — use conditional update so the skip signal
      // ([skip_web_search]) is never overwritten by a progress log.
      await service
        .from("reclass_jobs")
        .update({
          error_message: `[web_search] Searching: ${batchNames.join(" • ")}`,
        } as any)
        .eq("id", jobId)
        .neq("error_message", "[skip_web_search]");

      const results = await Promise.all(
        batch.map(async ([normalized, vendorName]) => {
          if (chunkController.signal.aborted) {
            return { normalized, vendorName, result: null };
          }
          try {
            const result = await webSearchVendor(
              { vendorName, clientCity, availableAccounts },
              { signal: chunkController.signal }
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
              ai_reasoning: result.reasoning, // already prefixed "(web search) ..."
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
          // Mark as searched (no good result) so this vendor is excluded from
          // future chunks and the "remaining" count decreases correctly.
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

  if (skippedByUser) {
    await service
      .from("reclass_jobs")
      .update({ status: "in_review", error_message: null } as any)
      .eq("id", jobId);
    return;
  }

  // Re-count remaining unsearched vendors to decide: pause again or finish.
  // We query distinct vendor_name values from rows still needing search.
  const { data: stillPending } = await service
    .from("reclassifications")
    .select("vendor_name")
    .eq("reclass_job_id", jobId)
    .in("decision", ["flagged", "needs_review"])
    .lt("ai_confidence", 0.7)
    .not("ai_reasoning", "ilike", "(web search%")
    .not("vendor_name", "is", null)
    .neq("vendor_name", "");

  const remaining = new Set((stillPending || []).map((r) => r.vendor_name)).size;
  const done = allRemainingCount - remaining;
  // Total across all chunks = done (this + previous chunks) + remaining
  const total = done + remaining;

  if (remaining > 0) {
    await service
      .from("reclass_jobs")
      .update({
        status: "web_search_paused",
        error_message: `[web_search_progress] ${done}/${total}`,
      } as any)
      .eq("id", jobId);
  } else {
    await service
      .from("reclass_jobs")
      .update({ status: "in_review", error_message: null } as any)
      .eq("id", jobId);
  }
}

export const maxDuration = 300;
