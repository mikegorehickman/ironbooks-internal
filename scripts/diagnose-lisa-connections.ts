// Diagnose: Lisa says she connected 30 QBO companies yesterday but they
// all show as disconnected. Walk the client_links table for anything
// touched in the last 48h and print the QBO connection signals so we can
// tell whether: (a) the rows have tokens but the UI is wrong, (b) the
// rows exist but tokens never landed, or (c) the rows aren't there.
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
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Find Lisa's user_id by email (best-effort — she may have a different one)
  const { data: lisa } = await supa
    .from("users")
    .select("id, email, full_name")
    .ilike("full_name", "%lisa%")
    .limit(5);
  console.log("=== USERS matching 'lisa' ===");
  for (const u of lisa || []) {
    console.log(`  ${(u as any).id}  ${(u as any).email}  ${(u as any).full_name}`);
  }
  console.log();

  // Rows updated in the last 48h, with QBO state
  const { data: recent } = await supa
    .from("client_links")
    .select(
      "id, client_name, qbo_company_name, qbo_realm_id, qbo_token_expires_at, is_active, linked_by, created_at, updated_at"
    )
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(60);

  // Fetch refresh-token presence separately (don't print the token itself)
  const ids = (recent || []).map((r: any) => r.id);
  const { data: tokenPresence } = await supa
    .from("client_links")
    .select("id, qbo_refresh_token, qbo_access_token")
    .in("id", ids);
  const tokenMap = new Map(
    (tokenPresence || []).map((r: any) => [
      r.id,
      {
        hasRefresh: !!r.qbo_refresh_token,
        hasAccess: !!r.qbo_access_token,
      },
    ])
  );

  console.log(`=== client_links updated in last 48h (${recent?.length || 0} rows) ===`);
  console.log(
    [
      "client_name",
      "realm",
      "refresh",
      "access",
      "expires_at",
      "active",
      "linked_by",
      "updated_at",
    ].join("\t")
  );
  let withTokens = 0,
    withoutTokens = 0,
    inactive = 0;
  for (const r of recent || []) {
    const t = tokenMap.get((r as any).id) || { hasRefresh: false, hasAccess: false };
    if (t.hasRefresh) withTokens++;
    else withoutTokens++;
    if (!(r as any).is_active) inactive++;
    const realm = (r as any).qbo_realm_id ? "Y" : "-";
    const refresh = t.hasRefresh ? "Y" : "-";
    const access = t.hasAccess ? "Y" : "-";
    const exp = (r as any).qbo_token_expires_at || "-";
    const active = (r as any).is_active ? "Y" : "N";
    console.log(
      [
        ((r as any).client_name || "").slice(0, 32),
        realm,
        refresh,
        access,
        exp,
        active,
        ((r as any).linked_by || "").slice(0, 8),
        (r as any).updated_at,
      ].join("\t")
    );
  }
  console.log();
  console.log(
    `Summary: ${withTokens} with refresh_token, ${withoutTokens} without, ${inactive} inactive`
  );

  // Recent OAuth-related audit_log entries
  const { data: auditLog } = await supa
    .from("audit_log")
    .select("event_type, client_link_id, user_id, request_payload, response_payload, occurred_at")
    .or("event_type.ilike.%qbo%,event_type.ilike.%oauth%,event_type.ilike.%connect%")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(50);
  console.log(`\n=== Recent QBO-related audit_log (last 48h, ${auditLog?.length || 0}) ===`);
  for (const a of auditLog || []) {
    console.log(
      `${(a as any).occurred_at}  ${(a as any).event_type}  client=${
        (a as any).client_link_id || "-"
      }  user=${((a as any).user_id || "").slice(0, 8)}`
    );
  }
})();
