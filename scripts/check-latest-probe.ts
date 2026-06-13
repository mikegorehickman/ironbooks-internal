// Check the most recent qbo_token_health_probe — the BS Cleanup picker
// uses this to decide who shows red. If the probe ran BEFORE Lisa
// reconnected the 30 clients, those clients are still flagged dead
// even though they're now healthy.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const { data: latestProbe } = await supa
    .from("audit_log")
    .select("event_type, request_payload, occurred_at, user_id")
    .eq("event_type", "qbo_token_health_probe")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestProbe) {
    console.log("No qbo_token_health_probe entries found in audit_log.");
    return;
  }
  const lp = latestProbe as any;
  const ageHours = (Date.now() - new Date(lp.occurred_at).getTime()) / (1000 * 60 * 60);
  console.log(`Latest probe: ${lp.occurred_at}  (${ageHours.toFixed(1)} hours ago)`);
  console.log(`Still fresh (<7d)? ${ageHours < 24 * 7 ? "YES" : "NO"}`);

  const dead = (lp.request_payload?.dead_clients || []) as Array<{ client?: string; code?: string }>;
  console.log(`\nDead clients in latest probe: ${dead.length}`);
  for (const d of dead) {
    console.log(`  ${d.client}  (${d.code})`);
  }

  // Now cross-reference: which of Lisa's recent reconnects appear in the dead list?
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: lisaReconnects } = await supa
    .from("client_links")
    .select("client_name, qbo_token_expires_at, updated_at")
    .gte("updated_at", since)
    .not("qbo_refresh_token", "is", null);

  const deadNames = new Set(dead.map((d) => d.client).filter(Boolean) as string[]);
  let falselyMarkedDead = 0;
  console.log("\n=== Lisa's recent reconnects that are STILL flagged dead by stale probe ===");
  for (const r of lisaReconnects || []) {
    const name = (r as any).client_name;
    if (deadNames.has(name)) {
      console.log(`  ${name}  (reconnected ${(r as any).updated_at}, probe was ${lp.occurred_at})`);
      falselyMarkedDead++;
    }
  }
  console.log(
    `\nTotal Lisa-reconnects falsely shown as dead: ${falselyMarkedDead} of ${lisaReconnects?.length || 0}`
  );
})();
