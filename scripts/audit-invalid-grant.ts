// Who are the 28 invalid_grant clients Lisa did NOT recently reconnect?
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
  const { data: health } = await svc
    .from("qbo_connection_health")
    .select("client_link_id, status, last_checked_at, error_message")
    .eq("status", "invalid_grant");

  const ids = (health || []).map((h: any) => h.client_link_id);
  const { data: clients } = await svc
    .from("client_links")
    .select(
      "id, client_name, linked_by, updated_at, qbo_token_expires_at, is_active"
    )
    .in("id", ids);

  // Pull bookkeeper names
  const userIds = [
    ...new Set((clients || []).map((c: any) => c.linked_by).filter(Boolean)),
  ];
  const { data: users } = await svc
    .from("users")
    .select("id, full_name")
    .in("id", userIds);
  const userMap = new Map<string, string>();
  for (const u of users || []) userMap.set((u as any).id, (u as any).full_name);

  console.log(`${health?.length || 0} clients with status=invalid_grant:\n`);
  console.log(
    "client_name                                | linked_by         | client_updated_at        | health_checked_at        | active"
  );
  console.log("-".repeat(140));
  for (const c of (clients || []).sort((a: any, b: any) =>
    b.updated_at.localeCompare(a.updated_at)
  )) {
    const h = (health || []).find(
      (x: any) => x.client_link_id === (c as any).id
    );
    const linker = userMap.get((c as any).linked_by) || "(unknown)";
    console.log(
      `${((c as any).client_name || "").padEnd(42)}| ${linker
        .slice(0, 18)
        .padEnd(18)}| ${(c as any).updated_at}| ${(h as any)?.last_checked_at}| ${
        (c as any).is_active ? "Y" : "N"
      }`
    );
  }
})();
