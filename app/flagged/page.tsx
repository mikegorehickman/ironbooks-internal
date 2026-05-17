import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { FlaggedQueue, type FlaggedJob } from "./flagged-queue";
import { Flag, ShieldAlert } from "lucide-react";

export default async function FlaggedPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // ─────────── Role gate ───────────
  const { data: profile } = await supabase
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "lead"].includes(profile.role)) {
    return (
      <AppShell>
        <TopBar title="Access restricted" />
        <div className="px-8 py-12 max-w-2xl">
          <div className="rounded-2xl p-8 bg-amber-50 border border-amber-200 text-center">
            <ShieldAlert size={36} className="mx-auto text-amber-600 mb-3" />
            <h2 className="text-lg font-bold text-navy mb-2">
              Senior bookkeeper access required
            </h2>
            <p className="text-sm text-ink-slate">
              The Flagged Queue is reserved for senior bookkeepers, leads, and admins.
              If you have items flagged on your jobs, they'll show up on your dashboard
              under "Awaiting senior review."
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const service = createServiceSupabase();

  // ─────────── Pull flagged items from all 3 sources in parallel ───────────
  const [coaQ, reclassQ, stripeQ] = await Promise.all([
    service
      .from("coa_actions")
      .select(`
        id, job_id, qbo_account_id, current_name, current_type, transaction_count,
        ai_confidence, ai_reasoning, ai_suggested_target, flagged_reason,
        coa_jobs!inner(id, status, created_at, bookkeeper_id, client_links(client_name, jurisdiction, state_province), users!bookkeeper_id(full_name))
      `)
      .eq("action", "flag")
      .eq("executed", false)
      .order("created_at", { ascending: false }),

    service
      .from("reclassifications")
      .select(`
        id, reclass_job_id, vendor_name, transaction_amount, transaction_date,
        from_account_name, to_account_name, ai_confidence, ai_reasoning, decision, description,
        reclass_jobs!reclass_job_id!inner(id, status, created_at, bookkeeper_id, client_links(client_name, jurisdiction, state_province), users!bookkeeper_id(full_name))
      `)
      .eq("decision", "flagged")
      .order("transaction_date", { ascending: false })
      .limit(500),

    service
      .from("stripe_recon_matches")
      .select(`
        id, job_id, qbo_deposit_id, deposit_amount, deposit_date, deposit_memo,
        matched_customer_names, ai_confidence, ai_reasoning, computed_fee,
        stripe_recon_jobs!inner(id, status, created_at, bookkeeper_id, client_links(client_name, jurisdiction, state_province), users(full_name))
      `)
      .eq("decision", "flagged")
      .eq("executed", false)
      .order("deposit_date", { ascending: false }),
  ]);

  // Surface any query errors so they're visible during debugging
  const queryErrors = [
    coaQ.error && `COA: ${coaQ.error.message}`,
    reclassQ.error && `Reclass: ${reclassQ.error.message}`,
    stripeQ.error && `Stripe: ${stripeQ.error.message}`,
  ].filter(Boolean);

  // ─────────── Group everything by (source, job_id) ───────────
  const groupedByJob = new Map<string, FlaggedJob>();

  function ensure(key: string, factory: () => FlaggedJob) {
    if (!groupedByJob.has(key)) groupedByJob.set(key, factory());
    return groupedByJob.get(key)!;
  }

  // COA
  for (const row of coaQ.data || []) {
    const job = (row as any).coa_jobs;
    if (!job) continue;
    const key = `coa::${job.id}`;
    const bucket = ensure(key, () => ({
      key,
      source: "coa",
      job_id: job.id,
      client_name: job.client_links?.client_name || "Unknown",
      jurisdiction: job.client_links?.jurisdiction || "",
      state_province: job.client_links?.state_province || "",
      bookkeeper_name: job.users?.full_name || "Unknown",
      bookkeeper_id: job.bookkeeper_id,
      job_status: job.status,
      created_at: job.created_at,
      items: [],
    }));
    bucket.items.push({
      id: row.id,
      type: "coa",
      headline: row.current_name || "Unknown account",
      subheadline: row.current_type || "",
      amount: null,
      date: null,
      ai_reasoning: row.ai_reasoning,
      flagged_reason: row.flagged_reason,
      ai_confidence: row.ai_confidence,
      ai_suggested_target: row.ai_suggested_target,
      transaction_count: row.transaction_count,
      raw: row,
    });
  }

  // Reclass
  for (const row of reclassQ.data || []) {
    const job = (row as any).reclass_jobs;
    if (!job) continue;
    const key = `reclass::${job.id}`;
    const bucket = ensure(key, () => ({
      key,
      source: "reclass",
      job_id: job.id,
      client_name: job.client_links?.client_name || "Unknown",
      jurisdiction: job.client_links?.jurisdiction || "",
      state_province: job.client_links?.state_province || "",
      bookkeeper_name: job.users?.full_name || "Unknown",
      bookkeeper_id: job.bookkeeper_id,
      job_status: job.status,
      created_at: job.created_at,
      items: [],
    }));
    bucket.items.push({
      id: row.id,
      type: "reclass",
      headline: (row as any).vendor_name || "Unknown vendor",
      subheadline: (row as any).from_account_name || "",
      amount: Number((row as any).transaction_amount || 0),
      date: (row as any).transaction_date,
      ai_reasoning: (row as any).ai_reasoning,
      flagged_reason: null,
      ai_confidence: (row as any).ai_confidence,
      ai_suggested_target: (row as any).to_account_name,
      transaction_count: null,
      raw: row,
    });
  }

  // Stripe
  for (const row of stripeQ.data || []) {
    const job = (row as any).stripe_recon_jobs;
    if (!job) continue;
    const key = `stripe::${job.id}`;
    const bucket = ensure(key, () => ({
      key,
      source: "stripe",
      job_id: job.id,
      client_name: job.client_links?.client_name || "Unknown",
      jurisdiction: job.client_links?.jurisdiction || "",
      state_province: job.client_links?.state_province || "",
      bookkeeper_name: job.users?.full_name || "Unknown",
      bookkeeper_id: job.bookkeeper_id,
      job_status: job.status,
      created_at: job.created_at,
      items: [],
    }));
    bucket.items.push({
      id: row.id,
      type: "stripe",
      headline: `Stripe deposit ${(row as any).qbo_deposit_id}`,
      subheadline: ((row as any).matched_customer_names || []).join(", ") || "No customers matched",
      amount: Number((row as any).deposit_amount || 0),
      date: (row as any).deposit_date,
      ai_reasoning: (row as any).ai_reasoning,
      flagged_reason: null,
      ai_confidence: (row as any).ai_confidence,
      ai_suggested_target: null,
      transaction_count: null,
      raw: row,
    });
  }

  // Sort by most-recent first
  const jobs = Array.from(groupedByJob.values()).sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );

  const totalItems = jobs.reduce((s, j) => s + j.items.length, 0);

  return (
    <AppShell>
      <TopBar
        title="Flagged for Senior Review"
        subtitle={
          totalItems === 0
            ? "Nothing in the queue"
            : `${totalItems} item${totalItems !== 1 ? "s" : ""} across ${jobs.length} job${jobs.length !== 1 ? "s" : ""}`
        }
      />
      <div className="px-8 py-6">
        {queryErrors.length > 0 && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 space-y-1">
            <div className="font-bold">Query errors (debug):</div>
            {queryErrors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}
        {jobs.length === 0 ? (
          <div className="rounded-xl bg-white border border-gray-200 px-8 py-16 text-center">
            <div className="rounded-full mx-auto mb-4 flex items-center justify-center w-14 h-14 bg-teal-light">
              <Flag size={24} className="text-teal" />
            </div>
            <h3 className="text-lg font-bold text-navy mb-1 tracking-tight">All clear</h3>
            <p className="text-sm text-ink-slate">No items waiting for senior review.</p>
          </div>
        ) : (
          <FlaggedQueue jobs={jobs} reviewerName={profile.full_name} />
        )}
      </div>
    </AppShell>
  );
}
