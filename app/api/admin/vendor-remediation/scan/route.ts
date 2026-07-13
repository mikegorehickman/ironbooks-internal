import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { scanForCandidates } from "@/lib/vendor-remediation";

/**
 * POST /api/admin/vendor-remediation/scan
 *
 * READ-ONLY fleet scan: which executed transactions does the reviewed vendor
 * KB now map to a different account? Returns candidates grouped per client →
 * per from→to transition, so the admin can verify per account before anything
 * is written. No QBO calls, no writes.
 */
export const maxDuration = 300;

export async function POST() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const candidates = await scanForCandidates();

  // Group: client → transition (current → target) → rows
  interface TransitionGroup {
    kind: "move" | "set_payee";
    current_account: string;
    target_account: string;
    count: number;
    total_amount: number;
    sample_vendors: string[];
    rows: typeof candidates;
  }
  const byClient = new Map<string, { client_name: string; transitions: Map<string, TransitionGroup> }>();
  for (const c of candidates) {
    const client =
      byClient.get(c.client_link_id) ??
      byClient.set(c.client_link_id, { client_name: c.client_name, transitions: new Map() }).get(c.client_link_id)!;
    const key = c.kind === "set_payee"
      ? `payee:${c.current_account}`
      : `${c.current_account} → ${c.target_account}`;
    const g =
      client.transitions.get(key) ??
      client.transitions.set(key, {
        kind: c.kind,
        current_account: c.current_account,
        target_account: c.target_account,
        count: 0,
        total_amount: 0,
        sample_vendors: [],
        rows: [],
      }).get(key)!;
    g.count++;
    g.total_amount += Math.abs(c.transaction_amount ?? 0);
    const v = (c.vendor_name || "").trim();
    if (v && !g.sample_vendors.includes(v) && g.sample_vendors.length < 5) g.sample_vendors.push(v);
    g.rows.push(c);
  }

  const clients = [...byClient.entries()]
    .map(([client_link_id, c]) => ({
      client_link_id,
      client_name: c.client_name,
      transitions: [...c.transitions.values()]
        .map((t) => ({ ...t, total_amount: Math.round(t.total_amount * 100) / 100 }))
        .sort((a, b) => b.count - a.count),
      total_rows: [...c.transitions.values()].reduce((s, t) => s + t.count, 0),
    }))
    .sort((a, b) => b.total_rows - a.total_rows);

  return NextResponse.json({
    scanned_at: new Date().toISOString(),
    total_candidates: candidates.length,
    total_clients: clients.length,
    clients,
  });
}
