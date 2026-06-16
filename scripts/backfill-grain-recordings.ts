/**
 * Backfill: cache all Ironbooks-hosted Grain recordings and auto-match them
 * to SNAP clients. Writes grain_recordings + grain_recording_matches.
 *
 * DRY RUN by default — pass --apply to write. Prints a coverage report:
 * total recordings seen, Ironbooks-hosted, matched (distinct clients),
 * unmatched recordings (the Call Matching queue).
 *
 * Run (token provided in the shell):
 *   GRAIN_API_TOKEN='...' npx tsx scripts/backfill-grain-recordings.ts
 *   GRAIN_API_TOKEN='...' npx tsx scripts/backfill-grain-recordings.ts --apply
 */

import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const raw of env.split("\n")) {
  const line = raw.replace(/\r$/, "").trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (key && !process.env[key]) process.env[key] = val;
}

import { createClient } from "@supabase/supabase-js";
import { listAllRecordings, getRecordingDetail } from "@/lib/grain";
import { matchRecording, type MatchClient, type MatchRule } from "@/lib/grain-matching";

const APPLY = process.argv.includes("--apply");
const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

(async () => {
  if (!process.env.GRAIN_API_TOKEN) {
    console.error("✗ GRAIN_API_TOKEN not set. Run: GRAIN_API_TOKEN='...' npx tsx scripts/backfill-grain-recordings.ts");
    process.exit(1);
  }
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — Grain recordings backfill\n`);

  // 1. Pull all recordings the token can see.
  const recordings = await listAllRecordings();
  console.log(`Fetched ${recordings.length} recordings from Grain.`);
  const ironbooks = recordings.filter((r) => r.ironbooksHost);
  console.log(`  ${ironbooks.length} hosted by @ironbooks.com.\n`);
  if (ironbooks.length === 0) {
    console.log("No Ironbooks-hosted recordings — check the token / API shape (lib/grain.ts).");
    return;
  }

  // 2. Load clients (+ portal emails) and learned rules.
  const { data: clientRows } = await supa
    .from("client_links")
    .select("id, client_name, client_email, contact_first_name, contact_last_name")
    .eq("is_active", true);
  const clients: MatchClient[] = (clientRows as any[]) || [];

  // portal-login emails per client
  try {
    const { data: cu } = await (supa as any).from("client_users").select("client_link_id, users(email)");
    const byClient = new Map<string, string[]>();
    for (const row of (cu || []) as any[]) {
      const e = row?.users?.email;
      if (row.client_link_id && e) {
        const arr = byClient.get(row.client_link_id) || [];
        arr.push(e);
        byClient.set(row.client_link_id, arr);
      }
    }
    for (const c of clients) c.portal_emails = byClient.get(c.id) || [];
  } catch { /* optional */ }

  const { data: ruleRows } = await (supa as any).from("grain_match_rules").select("rule_type, match_value, client_link_id");
  const rules: MatchRule[] = (ruleRows as any[]) || [];

  // 3. Enrich + store + match.
  let stored = 0, matchedRecordings = 0, totalMatches = 0;
  const perClient = new Map<string, number>();
  const unmatched: { id: string; title: string; when: string; who: string }[] = [];
  const clientName = new Map(clients.map((c) => [c.id, c.client_name]));

  for (const rec of ironbooks) {
    let full = rec;
    if (!rec.summary || rec.actionItems.length === 0) {
      const detail = await getRecordingDetail(rec.id);
      if (detail) {
        full = {
          ...rec,
          summary: rec.summary ?? detail.summary,
          actionItems: rec.actionItems.length ? rec.actionItems : detail.actionItems,
          participants: rec.participants.length ? rec.participants : detail.participants,
        };
      }
    }

    if (APPLY) {
      await supa.from("grain_recordings").upsert({
        id: full.id,
        title: full.title,
        url: full.url,
        start_datetime: full.startDatetime,
        duration: full.durationLabel,
        summary: full.summary,
        host_email: full.ironbooksHost?.email ?? null,
        host_name: full.ironbooksHost?.name ?? null,
        participants: full.participants,
        action_items: full.actionItems,
        has_ironbooks_host: true,
        updated_at: new Date().toISOString(),
        fetched_at: new Date().toISOString(),
      } as any, { onConflict: "id" });
    }
    stored++;

    const matches = matchRecording(full.participants, clients, rules);
    if (matches.size > 0) {
      matchedRecordings++;
      for (const [clientId, method] of matches) {
        totalMatches++;
        perClient.set(clientId, (perClient.get(clientId) || 0) + 1);
        if (APPLY) {
          await supa.from("grain_recording_matches").upsert({
            recording_id: full.id,
            client_link_id: clientId,
            match_method: method,
          } as any, { onConflict: "recording_id,client_link_id" });
        }
      }
    } else {
      const who = full.participants
        .filter((p) => (p.email || "").split("@")[1]?.toLowerCase() !== "ironbooks.com")
        .map((p) => p.email || p.name).filter(Boolean).slice(0, 2).join(", ");
      unmatched.push({ id: full.id, title: full.title, when: (full.startDatetime || "").slice(0, 10), who });
    }
  }

  // 4. Report.
  console.log("=".repeat(64));
  console.log(`RESULTS`);
  console.log("=".repeat(64));
  console.log(`  Ironbooks recordings ${APPLY ? "stored" : "seen"}: ${stored}`);
  console.log(`  Matched to a client:              ${matchedRecordings}`);
  console.log(`  Distinct clients with calls:      ${perClient.size}`);
  console.log(`  Total recording↔client links:     ${totalMatches}`);
  console.log(`  Unmatched (Call Matching queue):  ${unmatched.length}`);

  console.log(`\n  Per-client call counts:`);
  for (const [cid, n] of [...perClient.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${clientName.get(cid) || cid}: ${n}`);
  }
  if (unmatched.length) {
    console.log(`\n  UNMATCHED Ironbooks calls (need manual match or ignore):`);
    for (const u of unmatched.slice(0, 60)) console.log(`    [${u.when}] ${u.title}  —  ${u.who}`);
    if (unmatched.length > 60) console.log(`    …and ${unmatched.length - 60} more`);
  }
  if (!APPLY) console.log(`\n→ Re-run with --apply to write recordings + matches.\n`);
  else console.log("");
})();
