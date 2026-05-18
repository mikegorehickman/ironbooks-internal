import { sweepStaleJobs } from "@/lib/stale-jobs";
import { NextResponse } from "next/server";

/**
 * GET/POST /api/jobs/sweep-stale
 *
 * Watchdog endpoint. Auto-fails any background job (coa, reclass, stripe-recon)
 * that's been sitting in `executing` past its allowed window. See
 * lib/stale-jobs.ts for the rules.
 *
 * Safe to call from:
 *   - Vercel Cron (e.g. every 5 min)
 *   - The clients page on load (best-effort)
 *   - Manual curl during incident response
 *
 * Idempotent — almost always touches zero rows.
 */
export async function GET() {
  const result = await sweepStaleJobs();
  return NextResponse.json({ ok: true, ...result });
}

export const POST = GET;
