// Simulate what /fleet/qbo-health renders right now.
// Reproduces the logic in app/fleet/qbo-health/page.tsx so we can see
// exactly which clients show as "ok" vs "invalid_grant" etc.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const svc: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const [clientsRes, healthRes] = await Promise.all([
    svc
      .from("client_links")
      .select("id, client_name, qbo_realm_id, qbo_refresh_token, updated_at")
      .eq("is_active", true)
      .order("client_name"),
    svc.from("qbo_connection_health").select("*"),
  ]);

  console.log(
    `Total active clients: ${(clientsRes.data || []).length}, health rows: ${(healthRes.data || []).length}`
  );

  const healthByClient = new Map<string, any>();
  for (const h of healthRes.data || []) {
    healthByClient.set(String(h.client_link_id), h);
  }

  // Replicate page status logic
  const buckets: Record<string, number> = {};
  const examples: Record<string, string[]> = {};
  for (const c of clientsRes.data || []) {
    const h = healthByClient.get(String(c.id));
    let status: string;
    if (!c.qbo_realm_id) status = "never_connected";
    else if (!h) status = "unknown";
    else status = h.status;
    buckets[status] = (buckets[status] || 0) + 1;
    examples[status] = examples[status] || [];
    if (examples[status].length < 5) examples[status].push(c.client_name);
  }
  console.log("\nStatus distribution on /fleet/qbo-health:");
  for (const [s, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n}    e.g. ${examples[s].slice(0, 3).join(", ")}`);
  }

  // Now isolate the question: of Lisa's recent reconnects (rows updated
  // last 48h with a refresh token), what does the fleet page show?
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const recentReconnects = (clientsRes.data || []).filter(
    (c: any) => c.qbo_refresh_token && new Date(c.updated_at) >= since
  );
  console.log(`\nLisa's recent reconnects: ${recentReconnects.length}`);
  const recentBuckets: Record<string, number> = {};
  for (const c of recentReconnects) {
    const h = healthByClient.get(String(c.id));
    const status = !c.qbo_realm_id ? "never_connected" : !h ? "unknown" : h.status;
    recentBuckets[status] = (recentBuckets[status] || 0) + 1;
  }
  console.log("Status distribution for Lisa's recent reconnects:");
  for (const [s, n] of Object.entries(recentBuckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n}`);
  }

  // CRITICAL: what does the page filter show? Default view may filter to
  // "dead only" or similar. Let me check the client-side default filter.
})();
