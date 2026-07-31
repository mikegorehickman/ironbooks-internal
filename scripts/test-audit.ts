/** Tests for lib/audit.ts — the audit write helper and event categorisation.
 *  Run: npx tsx scripts/test-audit.ts
 *
 *  The failure this guards against is the one measured on 2026-07-28: an event
 *  recorded without the client it affected, making /admin/audit's client filter
 *  silently hide two thirds of the record.
 */
import {
  auditClient,
  auditFleet,
  categorizeAuditEvent,
  humanizeEventType,
  summarizeAuditPayload,
  AUDIT_CATEGORIES,
} from "../lib/audit";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }
const eq = (name: string, got: any, want: any) =>
  ok(`${name}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

/** Minimal stand-in for the Supabase client, capturing what would be inserted. */
function fakeService(opts: { failWith?: string } = {}) {
  const inserted: any[] = [];
  const svc: any = {
    from: () => ({
      insert: async (row: any) => {
        inserted.push(row);
        return opts.failWith ? { error: { message: opts.failWith } } : { error: null };
      },
    }),
  };
  return { svc, inserted };
}

async function main() {
  // ── The client id lands in the COLUMN, not just the payload ───────────────
  {
    const { svc, inserted } = fakeService();
    await auditClient(svc, {
      eventType: "qbo_rename",
      clientLinkId: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
      payload: { from: "Gas", to: "Vehicle Fuel" },
      jobId: "33333333-3333-3333-3333-333333333333",
    });
    eq("one row written", inserted.length, 1);
    eq("client_link_id is a real column value", inserted[0].client_link_id, "11111111-1111-1111-1111-111111111111");
    eq("event_type preserved", inserted[0].event_type, "qbo_rename");
    eq("user attributed", inserted[0].user_id, "22222222-2222-2222-2222-222222222222");
    eq("job kept for grouping", inserted[0].job_id, "33333333-3333-3333-3333-333333333333");
    ok("payload preserved", inserted[0].request_payload.to === "Vehicle Fuel");
  }

  // ── Fleet events are NULL client, deliberately — not "unknown" ────────────
  {
    const { svc, inserted } = fakeService();
    await auditFleet(svc, { eventType: "master_coa_change", payload: { operation: "rename" } });
    eq("fleet event has null client", inserted[0].client_link_id, null);
    eq("still records the event", inserted[0].event_type, "master_coa_change");
  }

  // ── Omitted optionals become explicit nulls, never undefined ─────────────
  //     An undefined in a Supabase insert is dropped from the row rather than
  //     stored as NULL, which makes columns inconsistent across writers.
  {
    const { svc, inserted } = fakeService();
    await auditClient(svc, { eventType: "x", clientLinkId: "44444444-4444-4444-4444-444444444444" });
    const row = inserted[0];
    for (const k of ["user_id", "job_id", "action_id", "api_endpoint", "http_method",
                     "status_code", "duration_ms", "error_message", "response_payload"]) {
      ok(`${k} is null, not undefined`, row[k] === null);
    }
    ok("missing payload becomes an empty object", JSON.stringify(row.request_payload) === "{}");
  }

  // ── A failing audit write must not throw, but MUST be logged ─────────────
  //     The inserts this replaces used a bare `catch {}`, so a failing audit
  //     write was indistinguishable from an action that never happened.
  {
    const { svc } = fakeService({ failWith: "permission denied" });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m: any) => errs.push(String(m));
    let threw = false;
    try {
      await auditClient(svc, { eventType: "qbo_merge", clientLinkId: "55555555-5555-5555-5555-555555555555" });
    } catch { threw = true; }
    console.error = orig;
    ok("does not throw on a failed write", !threw);
    ok("logs the failure loudly", errs.some((e) => e.includes("[audit] FAILED") && e.includes("qbo_merge")));
    ok("names the client in the failure log", errs.some((e) => e.includes("55555555")));
  }

  // ── Categorisation — the real event types seen in production ─────────────
  const cases: Array<[string, string]> = [
    ["qbo_rename", "chart"],
    ["qbo_merge", "chart"],
    ["qbo_inactivate", "chart"],
    ["auto_dismissed", "chart"],
    ["preflight_flagged", "chart"],
    ["master_coa_change", "chart"],
    ["manual_cleanup_required", "chart"],
    ["reclass_progress", "transactions"],
    ["reclass_job_created", "transactions"],
    ["stage_start", "transactions"],
    ["daily_recon_run", "recon"],
    ["month_end_sent", "monthEnd"],
    ["client_month_updated", "monthEnd"],
    ["portal_impersonate_start", "client"],
    ["onboarding_reward_failed", "client"],
    ["client_email_sent", "client"],
    ["user_permission_change", "access"],
    ["billing_dunning_cron", "billing"],
    ["stripe_connect_sent", "billing"],
  ];
  for (const [t, want] of cases) eq(`category of ${t}`, categorizeAuditEvent(t), want);

  // An unknown type must land in "other", never vanish — a new event type
  // becoming invisible because this map wasn't updated is the same class of bug
  // as the missing client id.
  eq("unknown type falls back to other", categorizeAuditEvent("some_brand_new_thing"), "other");
  eq("empty type falls back to other", categorizeAuditEvent(""), "other");

  ok("every category has a label", Object.values(AUDIT_CATEGORIES).every((c) => !!c.label));

  // ── Display helper ───────────────────────────────────────────────────────
  eq("humanize underscores", humanizeEventType("qbo_rename"), "Qbo rename");
  eq("humanize single word", humanizeEventType("login"), "Login");
  eq("humanize empty is safe", humanizeEventType(""), "");

  // ── Payload summary — the "What changed" column ───────────────────────────
  //     This is what /admin/audit and the client timeline render in the table.
  //     Before it existed you had to download the CSV to read the payload.
  eq(
    "rename shape",
    summarizeAuditPayload({ old_name: "Gas", new_name: "Vehicle Fuel" }),
    '"Gas" → "Vehicle Fuel"'
  );
  eq(
    "merge shape",
    summarizeAuditPayload({ source: "Aaron's Distributions", target: "Owner's Draw" }),
    `"Aaron's Distributions" → "Owner's Draw"`
  );
  eq(
    "reclass shape",
    summarizeAuditPayload({ from_account_name: "Travel", to_account_name: "Meals" }),
    "Travel → Meals"
  );
  eq("message shape", summarizeAuditPayload({ message: "Stage 2 complete" }), "Stage 2 complete");

  // An unrecognised payload must still show its content. Falling back to "—"
  // here is exactly the failure this replaces: detail that exists but is never
  // rendered is indistinguishable from an event that carries none.
  {
    const out = summarizeAuditPayload({ moved_lines: 28, remaining: 54, failed: 0 });
    ok(`unknown shape shows its values (got "${out}")`, out.includes("moved_lines: 28") && out.includes("remaining: 54"));
    ok("unknown shape is not a dash", out !== "—");
  }

  // Ids identify the row, they don't describe it — they must not crowd out content.
  {
    const out = summarizeAuditPayload({
      client_link_id: "d7c7701c-fb0b-4c57-91d1-cbb7c42f107d",
      reclass_job_id: "6a0423f9-0000-0000-0000-000000000000",
      unmapped: 24,
    });
    ok(`ids are filtered out (got "${out}")`, !out.includes("d7c7701c") && out.includes("unmapped: 24"));
  }

  // Nested values are named, not flattened into an unreadable blob.
  {
    const out = summarizeAuditPayload({ failures: ["a", "b", "c"], inactivated: false });
    ok(`array is counted not dumped (got "${out}")`, out.includes("3 item(s)") && !out.includes('"a"'));
  }

  eq("null payload", summarizeAuditPayload(null), "—");
  eq("undefined payload", summarizeAuditPayload(undefined), "—");
  eq("empty object", summarizeAuditPayload({}), "—");
  eq("non-object payload", summarizeAuditPayload("just a string"), "—");
  // All-noise payload has nothing to say, and says so rather than leaking an id.
  eq("payload of only ids", summarizeAuditPayload({ job_id: "x", user_id: "y" }), "—");

  console.log(`\naudit: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
