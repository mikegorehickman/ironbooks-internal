import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { findDuplicates } from "@/lib/qbo-dup-scan";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // ~50 clients × 1 QBO detail report each

/**
 * POST /api/admin/dup-scan   (admin/lead only)
 *   { period?: "2026-05", client_link_ids?: string[], min_amount?: 100 }
 *
 * Duplicate-transaction scan: pulls the FULL P&L transaction detail (cash
 * basis — what the published statements show) for each target client and
 * flags likely duplicate revenue/expense postings:
 *   - exact_same_day : same account + payee + amount + date, 2+ rows (HIGH)
 *   - near_duplicate : same account + payee + amount within 3 days (MEDIUM)
 *   - duplicate_doc  : same doc # + type + amount posted 2+ times (HIGH)
 * Recurring patterns (same key 4+ times in the month — weekly payroll, fuel)
 * are treated as legit and skipped. Default targets: active clients whose
 * `period` month was closed with statements. Findings only — no writes.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const b = await request.json().catch(() => ({}));
  const period: string = /^\d{4}-\d{2}$/.test(b.period || "") ? b.period : "2026-05";
  const minAmount: number = Number.isFinite(b.min_amount) ? Math.max(1, b.min_amount) : 100;
  const [y, m] = period.split("-").map(Number);
  const start = `${period}-01`;
  const end = `${y}-${String(m).padStart(2, "0")}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;

  // Targets: explicit ids, else every active client with a closed `period`.
  let ids: string[] = Array.isArray(b.client_link_ids) ? b.client_link_ids : [];
  if (!ids.length) {
    const { data: runs } = await (service as any)
      .from("monthly_rec_runs").select("client_link_id").eq("period", period).not("statements", "is", null);
    ids = [...new Set(((runs as any[]) || []).map((r) => r.client_link_id))];
  }
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name, contact_first_name, contact_last_name, qbo_realm_id, is_active")
    .in("id", ids.slice(0, 80));

  const targets = ((clients as any[]) || []).filter(
    (c) => c.is_active && c.qbo_realm_id && c.qbo_realm_id !== "DEMO" && !/\btest\b/i.test(c.client_name || "")
  );

  const results: any[] = [];
  for (const c of targets) {
    const base = {
      client_link_id: c.id,
      company: c.legal_business_name || c.client_name,
      contact: [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" "),
    };
    try {
      const token = await getValidToken(c.id, service as any);
      const rows = await fetchPLDetailAll(c.qbo_realm_id, token, start, end, "Cash");
      results.push({ ...base, scanned: rows.length, findings: findDuplicates(rows, minAmount) });
    } catch (e: any) {
      results.push({ ...base, scanned: 0, findings: [], error: e?.message || "QBO pull failed" });
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return NextResponse.json({
    period, start, end, min_amount: minAmount,
    clients: results.length,
    with_findings: results.filter((r) => r.findings.length).length,
    errors: results.filter((r) => r.error).length,
    results,
  });
}

// Duplicate-detection logic lives in lib/qbo-dup-scan.ts (shared with the
// books-verification engine).
