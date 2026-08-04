import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { reportDefects, type DefectReport, type ReconcileResult } from "@/lib/book-defects";

/**
 * POST /api/book-defects/sync — populate the ledger from what's already stored.
 *
 * Five of the defect classes already persist their findings somewhere; they
 * just never rolled up to a per-client answer. This derives ledger rows from
 * those existing stores, so the board is populated on day one without touching
 * a single scanner. Scanners that are still ephemeral (payroll double-count,
 * parent postings, COA merge JE damage) POST to /api/book-defects/report
 * instead — they have nothing to derive from.
 *
 * Idempotent and safe to re-run: reportDefects reconciles rather than appends.
 *
 * Each source is independently try/caught. A missing table (a scanner whose
 * migration hasn't been applied here) must degrade to "that type wasn't
 * swept", never take the whole sync down — that's the difference between a
 * partially-known fleet and a blank screen.
 */
export const dynamic = "force-dynamic";

const CENTS = (n: number) => Math.round(Math.abs(Number(n) || 0) * 100);

export async function POST() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const ranBy = user.id;

  const results: Record<string, ReconcileResult | { skipped: string }> = {};
  const run = async (type: string, fn: () => Promise<ReconcileResult>) => {
    try {
      results[type] = await fn();
    } catch (err: any) {
      results[type] = { skipped: err?.message || "source unavailable" };
    }
  };

  // ── Duplicates — dup_findings, the one class that already had a real ledger.
  await run("duplicate_transactions", async () => {
    const { data, error } = await (service as any)
      .from("dup_findings")
      .select("client_link_id, amount, tier, kind")
      .eq("status", "open")
      .limit(20000);
    if (error) throw error;
    // reversal_pair is an accounting artefact, not a duplicate — the fleet page
    // already excludes it from exposure, so the ledger must too or the two
    // screens disagree and nobody trusts either.
    const rows = ((data as any[]) || []).filter(
      (r) => r.kind !== "reversal_pair" && (r.tier === "certain" || r.tier === "likely")
    );
    const byClient = new Map<string, { cents: number; n: number }>();
    for (const r of rows) {
      const g = byClient.get(r.client_link_id) || { cents: 0, n: 0 };
      g.cents += CENTS(r.amount);
      g.n += 1;
      byClient.set(r.client_link_id, g);
    }
    const reports: DefectReport[] = [...byClient.entries()].map(([clientLinkId, g]) => ({
      clientLinkId,
      exposureCents: g.cents,
      itemCount: g.n,
      detail: { tiers: "certain+likely" },
    }));
    return reportDefects(service, {
      defectType: "duplicate_transactions",
      reports, scope: { kind: "fleet" }, source: "sync:dup_findings", ranBy,
    });
  });

  // ── COA conformance — coa_audit_scans is a per-client cache (PK client_link_id).
  // Only clients that have actually been scanned appear, so this is scoped to
  // them, NOT fleet: never mark a never-scanned client clean.
  await run("coa_nonconformance", async () => {
    const { data, error } = await (service as any)
      .from("coa_audit_scans")
      .select("client_link_id, conformance_pct, issue_count, stranded_cents, non_master, wrong_type, wrong_parent");
    if (error) throw error;
    const rows = (data as any[]) || [];
    const scanned = rows.map((r) => r.client_link_id);
    const reports: DefectReport[] = rows
      .filter((r) => (r.issue_count || 0) > 0)
      .map((r) => ({
        clientLinkId: r.client_link_id,
        exposureCents: r.stranded_cents ?? null,
        itemCount: r.issue_count ?? null,
        detail: {
          conformance_pct: r.conformance_pct,
          non_master: r.non_master,
          wrong_type: r.wrong_type,
          wrong_parent: r.wrong_parent,
        },
      }));
    return reportDefects(service, {
      defectType: "coa_nonconformance",
      reports,
      scope: { kind: "clients", ids: scanned },
      clientsScanned: scanned.length,
      source: "sync:coa_audit_scans",
      ranBy,
    });
  });

  // ── UCPI — ucpi_resolutions, pending rows only.
  await run("ucpi_unresolved", async () => {
    const { data, error } = await (service as any)
      .from("ucpi_resolutions")
      .select("client_link_id, unapplied_amount, status")
      .eq("status", "pending")
      .limit(20000);
    if (error) throw error;
    const byClient = new Map<string, { cents: number; n: number }>();
    for (const r of ((data as any[]) || [])) {
      const g = byClient.get(r.client_link_id) || { cents: 0, n: 0 };
      g.cents += CENTS(r.unapplied_amount);
      g.n += 1;
      byClient.set(r.client_link_id, g);
    }
    const reports: DefectReport[] = [...byClient.entries()].map(([clientLinkId, g]) => ({
      clientLinkId, exposureCents: g.cents, itemCount: g.n,
    }));
    // Persisted only when a scan opted in, so scope to who has rows.
    return reportDefects(service, {
      defectType: "ucpi_unresolved",
      reports,
      scope: { kind: "clients", ids: [...byClient.keys()] },
      source: "sync:ucpi_resolutions",
      ranBy,
    });
  });

  // ── Revenue double-count + CRM invoice double-count. These two never got a
  // table — the findings live in audit_log jsonb. Take the NEWEST row per
  // client and trust its exposure.
  //
  // GOTCHA, and it has bitten this exact pair of screens before: the timestamp
  // column is occurred_at, not created_at. Ordering by created_at returns rows
  // with a null sort key and silently reports zero findings.
  const fromAuditLog = async (
    eventType: string, defectKey: string, pick: (p: any) => { cents: number; n: number } | null
  ) => {
    const { data, error } = await (service as any)
      .from("audit_log")
      .select("client_link_id, request_payload, occurred_at")
      .eq("event_type", eventType)
      .order("occurred_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    const newest = new Map<string, any>();
    for (const row of ((data as any[]) || [])) {
      const cid = row.client_link_id || row.request_payload?.client_link_id;
      if (!cid || newest.has(cid)) continue; // newest-first, so first wins
      newest.set(cid, row.request_payload || {});
    }
    const reports: DefectReport[] = [];
    for (const [clientLinkId, payload] of newest.entries()) {
      const hit = pick(payload);
      if (hit && hit.cents > 0) {
        reports.push({ clientLinkId, exposureCents: hit.cents, itemCount: hit.n || null });
      }
    }
    return reportDefects(service, {
      defectType: defectKey,
      reports,
      // Only clients with a finding row have been swept; the rest are unknown.
      scope: { kind: "clients", ids: [...newest.keys()] },
      clientsScanned: newest.size,
      source: `sync:audit_log/${eventType}`,
      ranBy,
    });
  };

  await run("revenue_double_count", () =>
    fromAuditLog("revenue_integrity_finding", "revenue_double_count", (p) => {
      const cents = CENTS(p?.deposit_no_name_total ?? p?.deposit_total ?? 0);
      return cents > 0 ? { cents, n: Number(p?.deposit_count) || 0 } : null;
    })
  );

  await run("crm_invoice_double_count", () =>
    fromAuditLog("crm_invoice_revenue_finding", "crm_invoice_double_count", (p) => {
      const cents = CENTS(p?.paired_deposit_total ?? 0);
      return cents > 0 ? { cents, n: Number(p?.pair_count) || 0 } : null;
    })
  );

  // ── Phantom A/R — hardcore_cleanup_runs carries total_phantom_ar.
  await run("phantom_ar", async () => {
    const { data, error } = await (service as any)
      .from("hardcore_cleanup_runs")
      .select("client_link_id, total_phantom_ar, created_at")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    const newest = new Map<string, number>();
    for (const r of ((data as any[]) || [])) {
      if (!r.client_link_id || newest.has(r.client_link_id)) continue;
      newest.set(r.client_link_id, Number(r.total_phantom_ar) || 0);
    }
    const reports: DefectReport[] = [...newest.entries()]
      .filter(([, amt]) => amt > 0)
      .map(([clientLinkId, amt]) => ({ clientLinkId, exposureCents: CENTS(amt) }));
    return reportDefects(service, {
      defectType: "phantom_ar",
      reports,
      scope: { kind: "clients", ids: [...newest.keys()] },
      clientsScanned: newest.size,
      source: "sync:hardcore_cleanup_runs",
      ranBy,
    });
  });

  // ── Undeposited Funds — uf_audit_scans. Skip 'scanning' rows: an in-flight
  // scan reads as a zero balance, which would clear a client that was never
  // actually measured.
  await run("undeposited_funds", async () => {
    const { data, error } = await (service as any)
      .from("uf_audit_scans")
      .select("client_link_id, total_uf_balance, total_orphan_amount, orphan_count, status, created_at")
      .neq("status", "scanning")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    const newest = new Map<string, any>();
    for (const r of ((data as any[]) || [])) {
      if (!r.client_link_id || newest.has(r.client_link_id)) continue;
      newest.set(r.client_link_id, r);
    }
    const reports: DefectReport[] = [];
    for (const [clientLinkId, r] of newest.entries()) {
      // A finalized scan with a cleared balance is the success case — no defect.
      if (r.status === "finalized" && CENTS(r.total_uf_balance) === 0) continue;
      const cents = CENTS(r.total_uf_balance);
      if (cents > 0) {
        reports.push({
          clientLinkId,
          exposureCents: cents,
          itemCount: r.orphan_count ?? null,
          detail: { orphan_amount: r.total_orphan_amount, scan_status: r.status },
        });
      }
    }
    return reportDefects(service, {
      defectType: "undeposited_funds",
      reports,
      scope: { kind: "clients", ids: [...newest.keys()] },
      clientsScanned: newest.size,
      source: "sync:uf_audit_scans",
      ranBy,
    });
  });

  return NextResponse.json({ ok: true, results });
}
