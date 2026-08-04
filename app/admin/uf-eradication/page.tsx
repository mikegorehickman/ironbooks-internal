import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Wallet, AlertTriangle, ArrowRight, Clock } from "lucide-react";
import { ScanClientButton } from "./scan-client-button";
import { buildUfWorklists, sumByAction, UF_ACTION_LABEL, type UfAction, type UfItemRow } from "@/lib/uf-fleet";

export const dynamic = "force-dynamic";

/**
 * /admin/uf-eradication — fleet Undeposited Funds, one row per client.
 *
 * WHY THIS EXISTS. The cross-client UF picker was retired in July 2026 with the
 * sidebar simplification ("the tool starts from the client now"), which is right
 * for a bookkeeper working one client at a time and wrong for an eradication
 * campaign — that is fleet-first by nature. The consequence, measured
 * 2026-07-31: only 5 of 87 active clients had ever been scanned, those 5 held
 * $1,120,434 in UF, and a client sitting at ~$60K was invisible because nobody
 * had run it.
 *
 * UF is a CLEARING account. Every dollar here is money a customer paid that is
 * counted in neither revenue nor the bank. The target for every client is $0.
 *
 * Reads the stored `uf_audit_scans` + `uf_audit_items` rows. The per-client
 * scanner already does the matching — duplicate detection and
 * matchOrphansToDeposits — and persists the deposit each orphan probably belongs
 * to, the match kind, and a confidence. So this adds no new engine and no new
 * executor; it reads that work back and states the ACTION per payment.
 *
 * The first cut of this page reported four numbers per client and linked out.
 * Mike, correctly: "this tool is assuming we have all the information, but we
 * really need the tool to do the matching and recommending." Totals tell you the
 * size of the problem; a worklist tells a bookkeeper what to do next.
 */

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;

const daysAgo = (iso: string | null) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return Number.isFinite(d) ? d : null;
};

export default async function UfEradicationPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  // app/admin/layout.tsx already gates /admin/* to admin (+ billing_admin), so a
  // lead cannot reach this page. Matching that here rather than implying
  // otherwise — see the note in the PR about whether leads should have it.
  if ((actor as any)?.role !== "admin") redirect("/today");

  const [{ data: clients }, { data: scans }] = await Promise.all([
    service
      .from("client_links")
      .select("id, client_name, qbo_realm_id, cleanup_completed_at, daily_recon_enabled")
      .eq("is_active", true)
      .order("client_name"),
    service
      .from("uf_audit_scans" as any)
      .select(
        "id, client_link_id, created_at, status, uf_account_name, total_uf_balance, " +
          "uf_payments_total, matched_count, orphan_count, total_orphan_amount, " +
          "probable_deposited_count, probable_deposited_amount, finalized_at, error_message"
      )
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  // Per-payment rows for the newest scan of each client — this is where the
  // matcher's work lives.
  const latestScanIds = new Set<string>();
  const seenClient = new Set<string>();
  for (const s of ((scans as any[]) || [])) {
    if (seenClient.has(s.client_link_id)) continue;
    seenClient.add(s.client_link_id);
    if (s.status !== "failed") latestScanIds.add(s.id);
  }
  const scanToClient = new Map<string, string>(
    ((scans as any[]) || []).filter((s) => latestScanIds.has(s.id)).map((s) => [s.id, s.client_link_id])
  );

  let items: UfItemRow[] = [];
  let itemsUnavailable: string | null = null;
  if (latestScanIds.size) {
    const { data: itemRows, error: itemErr } = await service
      .from("uf_audit_items" as any)
      .select(
        "id, scan_id, qbo_payment_id, qbo_payment_txn_type, payment_date, payment_amount, " +
          "customer_name, payment_memo, payment_ref_num, applied_invoice_ids, classification, " +
          "suspected_duplicate, duplicate_of_payment_id, duplicate_reason, probable_deposit_id, " +
          "probable_deposit_date, probable_deposit_amount, probable_deposit_bank, " +
          "probable_match_kind, probable_match_confidence, probable_match_note, " +
          "probable_match_group, resolution"
      )
      .in("scan_id", [...latestScanIds])
      .limit(5000);
    if (itemErr) {
      // Migration 132 adds the probable_* columns; before it, this select 400s.
      // Say so rather than rendering an empty worklist that reads as "no work".
      itemsUnavailable = itemErr.message;
    } else {
      items = (itemRows as any[]) || [];
    }
  }
  const worklists = buildUfWorklists(items, scanToClient);
  const fleetActions = sumByAction(worklists.values());

  // Newest scan per client wins.
  const latest = new Map<string, any>();
  for (const s of ((scans as any[]) || [])) {
    if (!latest.has(s.client_link_id)) latest.set(s.client_link_id, s);
  }

  type Row = {
    id: string;
    name: string;
    connected: boolean;
    scan: any | null;
  };
  const rows: Row[] = ((clients as any[]) || []).map((c) => ({
    id: c.id,
    name: c.client_name || "(unnamed)",
    connected: !!c.qbo_realm_id,
    scan: latest.get(c.id) || null,
  }));

  const scanned = rows.filter((r) => r.scan && r.scan.status !== "failed");
  const neverScanned = rows.filter((r) => !r.scan);
  const failed = rows.filter((r) => r.scan?.status === "failed");

  // ── Fleet totals ─────────────────────────────────────────────────────────
  // Orphaned $ is the headline alongside the balance: an orphan is a payment
  // sitting in UF with no deposit behind it, which is the part that will NOT
  // resolve itself. The raw balance includes payments already tied to a deposit
  // and merely awaiting the Bank Deposit entry.
  const totalUf = scanned.reduce((s, r) => s + Math.abs(Number(r.scan.total_uf_balance) || 0), 0);
  const totalOrphan = scanned.reduce((s, r) => s + Math.abs(Number(r.scan.total_orphan_amount) || 0), 0);
  const orphanCount = scanned.reduce((s, r) => s + (Number(r.scan.orphan_count) || 0), 0);
  const clientsAtZero = scanned.filter((r) => Math.abs(Number(r.scan.total_uf_balance) || 0) < 1).length;
  const clientsWithUf = scanned.length - clientsAtZero;

  // Worst first — that is the work order.
  const sorted = [...scanned].sort(
    (a, b) =>
      Math.abs(Number(b.scan.total_orphan_amount) || 0) - Math.abs(Number(a.scan.total_orphan_amount) || 0) ||
      Math.abs(Number(b.scan.total_uf_balance) || 0) - Math.abs(Number(a.scan.total_uf_balance) || 0)
  );

  return (
    <div className="px-8 py-6 max-w-[1400px]">
      <div className="flex items-start gap-3 mb-1">
        <div className="rounded-md flex items-center justify-center w-9 h-9 bg-teal-light shrink-0">
          <Wallet size={16} className="text-teal-dark" />
        </div>
        <div>
          <h1 className="text-xl font-extrabold text-navy">Undeposited Funds — fleet</h1>
          <p className="text-xs text-ink-slate mt-0.5">
            UF is a clearing account. Every dollar here is money a customer paid that is counted in
            neither revenue nor the bank. The target for every client is $0.
          </p>
        </div>
      </div>

      {/* ── Totals. Orphaned $ is the number that matters most. ───────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5 mb-4">
        <div className="rounded-lg bg-white border-2 border-[#954E44]/50 shadow-card px-5 py-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#954E44]">
            Orphaned
          </div>
          <div className="text-3xl font-extrabold text-[#954E44] mt-1 tabular-nums">
            {fmt(totalOrphan)}
          </div>
          <div className="text-[11px] text-ink-slate mt-1">
            {orphanCount.toLocaleString()} payment{orphanCount === 1 ? "" : "s"} with no deposit
            behind them — this is the part that will not resolve itself
          </div>
        </div>
        <div className="rounded-lg bg-white border border-cardline shadow-card px-5 py-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-slate">
            Total in UF
          </div>
          <div className="text-3xl font-extrabold text-navy mt-1 tabular-nums">{fmt(totalUf)}</div>
          <div className="text-[11px] text-ink-slate mt-1">
            across {clientsWithUf} client{clientsWithUf === 1 ? "" : "s"} · {clientsAtZero} already
            at zero
          </div>
        </div>
        <div className="rounded-lg bg-white border border-cardline shadow-card px-5 py-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-teal-dark">
            Recommended actions
          </div>
          <div className="mt-1.5 space-y-1">
            {(["create_deposit", "void_duplicate", "ask_client"] as UfAction[]).map((a) => (
              <div key={a} className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-ink-slate">{UF_ACTION_LABEL[a]}</span>
                <span className="text-sm font-bold text-navy tabular-nums">
                  {fmt(fleetActions[a].amount)}
                  <span className="text-[10px] text-ink-light font-normal">
                    {" "}
                    ({fleetActions[a].count})
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-ink-slate mt-1.5">
            SNAP matched these — no client conversation needed for the first two
          </div>
        </div>
        <div className="rounded-lg bg-white border border-cardline shadow-card px-5 py-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-slate">
            Coverage
          </div>
          <div className="text-3xl font-extrabold text-navy mt-1 tabular-nums">
            {scanned.length}
            <span className="text-lg text-ink-light">/{rows.length}</span>
          </div>
          <div className="text-[11px] text-ink-slate mt-1">
            {neverScanned.length > 0 ? (
              <span className="text-[#8A6D2F] font-semibold">
                {neverScanned.length} never scanned — the fleet total is a floor, not a total
              </span>
            ) : (
              "every active client scanned"
            )}
          </div>
        </div>
      </div>

      {/* Coverage honesty: an unscanned client is not a clean client. */}
      {neverScanned.length > 0 && (
        <div className="rounded-lg border border-[#DAB461]/40 bg-[#DAB461]/10 px-4 py-3 mb-4 flex items-start gap-2">
          <AlertTriangle size={14} className="text-[#8A6D2F] mt-0.5 shrink-0" />
          <div className="text-xs text-[#6B5524] leading-relaxed">
            <span className="font-semibold">
              {neverScanned.length} of {rows.length} active clients have never been scanned.
            </span>{" "}
            Their UF is unknown, not zero — so every total above is a floor. Scan them to find out
            what the real number is.
          </div>
        </div>
      )}

      {itemsUnavailable && (
        <div className="rounded-lg border border-[#954E44]/40 bg-[#954E44]/8 px-4 py-3 mb-4 text-xs text-[#7A3F37]">
          <span className="font-semibold">Per-payment detail unavailable.</span> {itemsUnavailable} —
          the recommendations below are empty because the query failed, NOT because there is no work.
          (Migration 132 adds the probable-match columns.)
        </div>
      )}

      {/* ── The worklist. One row per payment, with the match and the action. ── */}
      <div className="space-y-4">
        {sorted.map((r) => {
          const s2 = r.scan;
          const work = worklists.get(r.id);
          const open = (work?.items || []).filter((i) => !i.done);
          const bal = Math.abs(Number(s2.total_uf_balance) || 0);
          const age = daysAgo(s2.created_at);
          if (bal < 1 && open.length === 0) return null; // already at zero — nothing to show
          return (
            <div key={r.id} className="rounded-xl bg-white border border-cardline shadow-card overflow-hidden">
              <div className="px-5 py-3 border-b border-rule flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <Link href={`/clients/${r.id}`} className="text-[15px] font-extrabold text-navy hover:text-teal-dark">
                    {r.name}
                  </Link>
                  <div className="text-[11px] text-ink-slate mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[#954E44]">{fmt(work?.openAmount ?? 0)} orphaned</span>
                    <span className="text-ink-light">·</span>
                    <span>{fmt(bal)} total in {s2.uf_account_name || "UF"}</span>
                    <span className="text-ink-light">·</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock size={10} className="text-ink-light" />
                      scanned {String(s2.created_at || "").slice(0, 10)}
                      {age != null && age > 30 && <span className="text-[#8A6D2F] font-semibold">({age}d — rescan)</span>}
                    </span>
                  </div>
                </div>
                <Link
                  href={`/balance-sheet/${r.id}/uf-audit`}
                  className="inline-flex items-center gap-1.5 bg-navy text-white text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-navy-light shrink-0"
                >
                  Open the fix <ArrowRight size={11} className="text-gold" />
                </Link>
              </div>

              {open.length === 0 ? (
                <p className="px-5 py-4 text-xs text-ink-slate">
                  {work
                    ? "Every orphan on this scan has already been resolved — rescan to confirm UF is clear."
                    : "No per-payment detail on this scan. Rescan to get recommendations."}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#F5F7F9] text-[10px] font-bold uppercase tracking-wider text-ink-slate">
                        <th className="text-left px-5 py-2">Date</th>
                        <th className="text-left px-3 py-2">Customer</th>
                        <th className="text-right px-3 py-2">Amount</th>
                        <th className="text-left px-3 py-2">Do this</th>
                        <th className="text-left px-5 py-2">Why — what SNAP matched</th>
                      </tr>
                    </thead>
                    <tbody>
                      {open.slice(0, 25).map((i) => (
                        <tr key={i.id} className="border-t border-hairline align-top hover:bg-[#FBFCFD]">
                          <td className="px-5 py-2 text-xs text-ink-slate whitespace-nowrap">{i.date}</td>
                          <td className="px-3 py-2 text-xs text-navy font-medium">{i.customer}</td>
                          <td className="px-3 py-2 text-right text-xs font-bold text-navy tabular-nums whitespace-nowrap">
                            {fmt(i.amount)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span
                              className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                                i.action === "create_deposit"
                                  ? "bg-[#3E908D]/12 text-[#2F6F6C]"
                                  : i.action === "void_duplicate"
                                  ? "bg-[#954E44]/12 text-[#954E44]"
                                  : "bg-[#DAB461]/20 text-[#8A6D2F]"
                              }`}
                            >
                              {UF_ACTION_LABEL[i.action]}
                            </span>
                            {i.confidence != null && (
                              <div className="text-[10px] text-ink-light mt-0.5">
                                {Math.round(i.confidence * 100)}% confident
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-2 text-xs text-ink-slate leading-relaxed">{i.recommendation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {open.length > 25 && (
                    <p className="px-5 py-2 text-[11px] text-ink-slate border-t border-hairline">
                      Showing the 25 largest of {open.length}. The rest are in the per-client tool.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="rounded-xl bg-white border border-cardline shadow-card px-5 py-10 text-center text-sm text-ink-slate">
            No scans yet. Scan a client below to start.
          </div>
        )}
      </div>

      {/* ── Never scanned ────────────────────────────────────────────────── */}
      {neverScanned.length > 0 && (
        <div className="rounded-xl bg-white border border-cardline shadow-card overflow-hidden mt-5">
          <div className="px-5 py-3 border-b border-rule">
            <h2 className="text-[13px] font-extrabold uppercase tracking-wide text-navy">
              Never scanned · {neverScanned.length}
            </h2>
            <p className="text-[11px] text-ink-slate mt-0.5">
              Unknown, not zero. Each scan is read-only against QuickBooks and takes 10–30 seconds.
            </p>
          </div>
          <div className="divide-y divide-hairline max-h-[420px] overflow-y-auto">
            {neverScanned.map((r) => (
              <div key={r.id} className="px-5 py-2.5 flex items-center justify-between gap-3">
                <Link
                  href={`/clients/${r.id}`}
                  className="text-sm font-medium text-navy hover:text-teal-dark truncate"
                >
                  {r.name}
                </Link>
                {r.connected ? (
                  <ScanClientButton clientLinkId={r.id} clientName={r.name} />
                ) : (
                  <span className="text-[11px] text-ink-light italic shrink-0">
                    not connected to QuickBooks
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {failed.length > 0 && (
        <div className="rounded-lg border border-[#954E44]/40 bg-[#954E44]/8 px-4 py-3 mt-5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#954E44] mb-1">
            Scan failed · {failed.length}
          </div>
          {failed.map((r) => (
            <div key={r.id} className="text-xs text-[#7A3F37]">
              <span className="font-semibold">{r.name}</span>:{" "}
              {r.scan?.error_message || "unknown error"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
