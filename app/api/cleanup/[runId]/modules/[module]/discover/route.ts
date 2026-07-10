import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { discoverModule } from "@/lib/cleanup-system/modules";
import type { CleanupModule } from "@/lib/cleanup-system/types";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const VALID_MODULES: CleanupModule[] = [
  "bank_recon",
  "undeposited_funds",
  "accounts_receivable",
  "ar_aging",
  "accounts_payable",
  "loans",
  "shareholder_draws",
  "tax_payroll",
  "obe_uncategorized",
];

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; module: string }> }
) {
  const { runId, module } = await context.params;
  const body = await request.json().catch(() => ({}));
  const crmSource = body.crm_source as string | undefined;
  const crmCsvText = body.crm_csv_text as string | undefined;
  // AR Aging Cleanup options: engagement cutoff + optional deposits CSV.
  const cutoffDate =
    typeof body.cutoff_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.cutoff_date)
      ? (body.cutoff_date as string)
      : undefined;
  const depositCsvText =
    typeof body.deposit_csv_text === "string" ? (body.deposit_csv_text as string) : undefined;
  if (!VALID_MODULES.includes(module as CleanupModule)) {
    return NextResponse.json({ error: "Invalid module" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("cleanup_runs")
    .select("client_link_id, period_lock_date, status")
    .eq("id", runId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const perm = await requireOwnerOrSenior(
    service,
    (run as any).client_link_id,
    auth.userId,
    auth.role
  );
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  after(async () => {
    try {
      await discoverModule(
        service,
        runId,
        (run as any).client_link_id,
        module as CleanupModule,
        (run as any).period_lock_date || new Date().toISOString().slice(0, 10),
        module === "accounts_receivable" && crmCsvText
          ? {
              crmSource: (crmSource as any) || "generic",
              crmCsvText,
            }
          : module === "ar_aging"
          ? { cutoffDate, depositCsvText }
          : undefined
      );
      await service
        .from("cleanup_runs")
        .update({ status: "reviewing", updated_at: new Date().toISOString() } as any)
        .eq("id", runId);
    } catch (err: any) {
      await service
        .from("cleanup_run_modules")
        .update({ status: "failed", error_message: err.message } as any)
        .eq("run_id", runId)
        .eq("module", module as any);
    }
  });

  return NextResponse.json({ ok: true, message: "Discovery started" });
}
