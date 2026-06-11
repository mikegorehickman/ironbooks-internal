import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ count: 0 });

  const service = createServiceSupabase();

  const { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "lead"].includes(profile.role)) {
    return NextResponse.json({ count: 0 });
  }

  // Run the same queries as the flagged page — active (in_review) jobs
  // only, so completed/failed jobs' flags don't inflate the badge.
  const [coaQ, reclassQ, stripeQ] = await Promise.all([
    service
      .from("coa_actions")
      .select(`id, coa_jobs!inner(id, status, users!bookkeeper_id(id))`)
      .eq("action", "flag")
      .eq("executed", false)
      .eq("bookkeeper_override", true)
      .eq("coa_jobs.status", "in_review"),

    service
      .from("reclassifications")
      .select(`id, reclass_jobs!reclass_job_id!inner(id, status, users!bookkeeper_id(id))`)
      .eq("decision", "flagged")
      .eq("bookkeeper_override", true)
      .eq("reclass_jobs.status", "in_review"),

    service
      .from("stripe_recon_matches")
      .select(`id, stripe_recon_jobs!inner(id, status, users!bookkeeper_id(id))`)
      .eq("decision", "flagged")
      .eq("executed", false)
      .eq("bookkeeper_override", true)
      .eq("stripe_recon_jobs.status", "in_review"),
  ]);

  // Apply the same JS filtering as the flagged page
  const coaCount = (coaQ.data || []).filter((r: any) => r.coa_jobs).length;
  const reclassCount = (reclassQ.data || []).filter((r: any) => r.reclass_jobs).length;
  const stripeCount = (stripeQ.data || []).filter((r: any) => r.stripe_recon_jobs).length;

  return NextResponse.json({ count: coaCount + reclassCount + stripeCount });
}
