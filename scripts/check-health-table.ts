// Cross-reference qbo_connection_health.status against Lisa's recent
// reconnects. Hypothesis: callback updates client_links but never resets
// qbo_connection_health.status, so the Fleet QBO Health page still
// thinks dead-then-reconnected clients are dead.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const supa: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supa
    .from("client_links")
    .select("id, client_name, updated_at, qbo_token_expires_at")
    .gte("updated_at", since)
    .not("qbo_refresh_token", "is", null);

  if (!recent || recent.length === 0) {
    console.log("No recent reconnects found.");
    return;
  }
  const ids = recent.map((r: any) => r.id);

  const { data: healthRows } = await supa
    .from("qbo_connection_health")
    .select("*")
    .in("client_link_id", ids);

  const healthById = new Map<string, any>();
  for (const h of healthRows || []) {
    healthById.set(String(h.client_link_id), h);
  }

  console.log(`=== ${recent.length} Lisa-recent reconnects vs qbo_connection_health.status ===`);
  let stale = 0,
    ok = 0,
    missing = 0;
  for (const r of recent) {
    const h = healthById.get(String(r.id));
    const reconnectedAt = new Date(r.updated_at);
    if (!h) {
      missing++;
      console.log(`  ${r.client_name.padEnd(40)}  no health row`);
      continue;
    }
    const lastChecked = h.last_checked_at ? new Date(h.last_checked_at) : null;
    const isStale =
      h.status !== "ok" && lastChecked && lastChecked < reconnectedAt;
    if (isStale) {
      stale++;
      console.log(
        `  ${r.client_name.padEnd(40)}  STALE: status=${h.status}  ` +
          `checked=${h.last_checked_at}  reconnected=${r.updated_at}`
      );
    } else if (h.status === "ok") {
      ok++;
    } else {
      console.log(
        `  ${r.client_name.padEnd(40)}  status=${h.status}  checked=${h.last_checked_at}`
      );
    }
  }
  console.log(
    `\nSummary: ${ok} ok | ${stale} STALE (showing dead but actually reconnected) | ${missing} missing health row`
  );
})();
