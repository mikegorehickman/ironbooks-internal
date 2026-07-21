import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Search, ArrowRight, Sparkles, Wallet, Flame } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/ar-recovery
 *
 * Landing page for all three A/R recovery tools.
 * Bookkeeper picks the one that matches the mess in front of her.
 */
export default async function ArRecoveryLanding({
  params,
}: {
  params: Promise<{ client_id: string }>;
}) {
  const { client_id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  // Fail-soft latest-scan badges per tool
  let ufAuditScan: any = null;
  let uncatScan: any = null;
  try {
    const { data } = await service
      .from("uf_audit_scans" as any)
      .select("created_at, status, orphan_count, total_orphan_amount")
      .eq("client_link_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    ufAuditScan = data;
  } catch {}
  try {
    const { data } = await service
      .from("uncat_income_scans" as any)
      .select("created_at, status, deposits_scanned, total_uncat_amount, exact_single_count, no_match_count")
      .eq("client_link_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    uncatScan = data;
  } catch {}

  return (
    <AppShell>
      <TopBar
        title={`A/R Recovery — ${(client as any).client_name}`}
        subtitle="Find money that arrived but never got applied to the right invoice — three tools, one toolbox"
      />
      <div className="px-8 py-6 max-w-6xl space-y-4">
        <Link
          href={`/balance-sheet/${client_id}/coa`}
          className="inline-flex items-center gap-1 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} />
          Back to BS COA viewer
        </Link>

        {/* Consolidation banner — these three flows are merging into the
            unified Hardcore BS Cleanup. The tiles below stay for in-flight
            jobs but the recommended path is one button up. */}
        <div className="p-4 bg-teal-lighter/40 border-2 border-teal/30 rounded-lg max-w-3xl">
          <div className="text-sm font-bold text-navy mb-1">
            Use BS Cleanup for UF → A/R and duplicate invoices
          </div>
          <p className="text-xs text-ink-slate leading-relaxed mb-2">
            Undeposited Funds matching and A/R duplicate voids now run in the
            guided BS Cleanup wizard — discover, review, approve, and post to
            QuickBooks in one flow. Start a new cleanup here; legacy tiles
            below remain for in-flight scans only.
          </p>
          <Link
            href={`/balance-sheet/${client_id}/cleanup`}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-teal hover:text-teal-dark"
          >
            Open BS Cleanup → <ArrowRight size={11} />
          </Link>
        </div>

        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900 max-w-3xl">
          <strong>Legacy tiles:</strong> UF Audit, standalone UF→A/R matcher, and
          Uncategorized Income Recovery are deprecated for new work. UF matching
          and duplicate voids are handled in BS Cleanup; uncat income recovery
          is not yet in the wizard.
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          {/* UF Audit */}
          <Link
            href={`/balance-sheet/${client_id}/uf-audit`}
            className="block p-5 bg-white border-2 border-slate-200 rounded-lg hover:border-slate-400 hover:shadow-md transition group"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-amber-100 text-amber-700 rounded flex items-center justify-center">
                <Search size={16} />
              </div>
              <div className="font-bold text-navy">Undeposited Funds Audit</div>
              <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-ink-slate rounded font-semibold">
                LEGACY
              </span>
            </div>
            <p className="text-xs text-ink-slate mb-3">
              Find Receive-Payment entries in Undeposited Funds that have no
              corresponding bank deposit. Resolve via Owner Draw, Write-off,
              ask-client email, or manual flag.
            </p>
            {ufAuditScan && (
              <div className="text-[11px] text-amber-700 font-semibold">
                Last scan: {ufAuditScan.orphan_count || 0} orphan
                {ufAuditScan.orphan_count === 1 ? "" : "s"} ·{" "}
                {Number(ufAuditScan.total_orphan_amount || 0).toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}
              </div>
            )}
            <div className="text-xs text-teal font-semibold group-hover:underline mt-2 inline-flex items-center gap-1">
              Open <ArrowRight size={12} />
            </div>
          </Link>

          {/* UF → A/R matcher */}
          <Link
            href={`/balance-sheet/${client_id}`}
            className="block p-5 bg-white border-2 border-slate-200 rounded-lg hover:border-slate-400 hover:shadow-md transition group"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-teal-light text-teal-dark rounded flex items-center justify-center">
                <Wallet size={16} />
              </div>
              <div className="font-bold text-navy">Match UF → Open A/R</div>
              <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-ink-slate rounded font-semibold">
                LEGACY
              </span>
            </div>
            <p className="text-xs text-ink-slate mb-3">
              Take Receive-Payments stuck in UF with a known customer + amount,
              and apply them to that customer's open invoices. Best when UF
              just needs to be applied, not investigated.
            </p>
            <div className="text-[11px] text-ink-slate italic mb-2">
              Launches from the main Balance Sheet page → UF → A/R button.
            </div>
            <div className="text-xs text-teal font-semibold group-hover:underline mt-2 inline-flex items-center gap-1">
              Go to BS page <ArrowRight size={12} />
            </div>
          </Link>

          {/* Uncategorized Income Recovery */}
          <Link
            href={`/balance-sheet/${client_id}/uncat-income-recovery`}
            className="block p-5 bg-white border-2 border-slate-200 rounded-lg hover:border-teal hover:shadow-md transition group"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-teal-light text-teal-dark rounded flex items-center justify-center">
                <Sparkles size={16} />
              </div>
              <div className="font-bold text-navy">Uncategorized Income Recovery</div>
              <span className="text-[10px] px-1.5 py-0.5 bg-teal-light text-teal-dark rounded font-semibold">
                NEW
              </span>
            </div>
            <p className="text-xs text-ink-slate mb-3">
              Find deposits landed in "Uncategorized Income" because the
              bookkeeper didn't know the customer. Auto-match to open invoices,
              Claude infers customer from bank descriptions, one-click apply.
            </p>
            {uncatScan && (
              <div className="text-[11px] text-teal-dark font-semibold">
                Last scan: {uncatScan.deposits_scanned || 0} deposits ·{" "}
                {Number(uncatScan.total_uncat_amount || 0).toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}{" "}
                · {uncatScan.exact_single_count || 0} exact match
              </div>
            )}
            <div className="text-xs text-teal font-semibold group-hover:underline mt-2 inline-flex items-center gap-1">
              Open <ArrowRight size={12} />
            </div>
          </Link>

          {/* Hardcore BS Cleanup — Phase 1 (duplicate invoices from CRM migration) */}
          <Link
            href={`/balance-sheet/${client_id}/hardcore-cleanup`}
            className="block p-5 bg-white border-2 border-red-300 rounded-lg hover:border-red-500 hover:shadow-md transition group"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-red-100 text-red-700 rounded flex items-center justify-center">
                <Flame size={16} />
              </div>
              <div className="font-bold text-navy">Hardcore BS Cleanup</div>
              <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-800 rounded font-semibold">
                NEW
              </span>
            </div>
            <p className="text-xs text-ink-slate mb-3">
              For CRM-migration messes (Drip Jobs → Jobber, etc.) where QBO has 3-4 phantom
              invoices per real job. Upload the CRM job report, SNAP cross-references against
              QBO open A/R, flags duplicates, pushes JE write-offs (closed periods) or voids
              (open periods) to QBO.
            </p>
            <div className="text-xs text-teal font-semibold group-hover:underline mt-2 inline-flex items-center gap-1">
              Open <ArrowRight size={12} />
            </div>
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
