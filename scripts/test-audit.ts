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

  console.log(`\naudit: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
