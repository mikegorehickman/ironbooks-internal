/** Unit tests for lib/client-lifecycle.ts derivation.
 *  Run: npx tsx scripts/test-client-lifecycle.ts */
import { deriveLifecycleStatus, deriveMacroStage } from "../lib/client-lifecycle";
import { previousMonthPeriod } from "../lib/monthly-rec";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { cond ? pass++ : (fail++, console.error(`  ✗ ${name}`)); }

const curPeriodEnd = previousMonthPeriod().periodEnd; // "YYYY-MM-DD" in the current close month

// ── Bug A: daily recon on, cleanup_completed_at NULL (D. Tresham class) ──
// Previously fell through to a cleanup pipeline status; production-board
// actions couldn't take effect.
ok("daily recon on + no cleanup + no signals → in_production",
  deriveLifecycleStatus({ daily_recon_enabled: true, cleanup_completed_at: null }) === "in_production");

ok("daily recon on + no cleanup + month_waiting_client → waiting_on_client",
  deriveLifecycleStatus({ daily_recon_enabled: true, cleanup_completed_at: null, month_waiting_client: true }) === "waiting_on_client");

ok("daily recon on + no cleanup + month_review → ready_for_review",
  deriveLifecycleStatus({ daily_recon_enabled: true, cleanup_completed_at: null, month_review: true }) === "ready_for_review");

ok("macro-stage: daily recon on + no cleanup → production",
  deriveMacroStage({ daily_recon_enabled: true, cleanup_completed_at: null }) === "production");

// ── Bug B: month closed via latest_closed_period marker (Co Painting class) ──
ok("daily recon + cleanup set + latest_closed_period covers current period → done",
  deriveLifecycleStatus({ daily_recon_enabled: true, cleanup_completed_at: "set", latest_closed_period: curPeriodEnd }) === "done");

ok("daily recon + latest_closed_period covers current period (no run) → done",
  deriveLifecycleStatus({ daily_recon_enabled: true, cleanup_completed_at: null, latest_closed_period: curPeriodEnd }) === "done");

ok("month_done flag alone → done",
  deriveLifecycleStatus({ daily_recon_enabled: true, cleanup_completed_at: "set", month_done: true }) === "done");

// A STALE latest_closed_period (an old month) must NOT mark the current month done.
ok("stale latest_closed_period does NOT force done",
  deriveLifecycleStatus({ daily_recon_enabled: true, cleanup_completed_at: "set", latest_closed_period: "2020-01-31" }) === "in_production");

// ── Regressions: existing behavior preserved ──
ok("cleanup_completed_at set, daily recon OFF → completed",
  deriveLifecycleStatus({ daily_recon_enabled: false, cleanup_completed_at: "set" }) === "completed");

ok("in_review (cleanup) → ready_for_review",
  deriveLifecycleStatus({ daily_recon_enabled: false, cleanup_completed_at: null, cleanup_review_state: "in_review" }) === "ready_for_review");

ok("failed_review (cleanup) → failed_review",
  deriveLifecycleStatus({ daily_recon_enabled: false, cleanup_completed_at: null, cleanup_review_state: "failed_review" }) === "failed_review");

ok("open_ask_client in cleanup → waiting_on_client",
  deriveLifecycleStatus({ daily_recon_enabled: false, cleanup_completed_at: null, open_ask_client: true }) === "waiting_on_client");

ok("active reclass → reclassify",
  deriveLifecycleStatus({ daily_recon_enabled: false, has_active_reclass: true }) === "reclassify");

ok("onboarding (no qbo) → onboarding",
  deriveLifecycleStatus({ daily_recon_enabled: false, status: "onboarding", qbo_connected: false }) === "onboarding");

ok("macro-stage: cleanup_completed, daily recon off → cleanup (awaiting promotion)",
  deriveMacroStage({ daily_recon_enabled: false, cleanup_completed_at: "set" }) === "cleanup");

ok("macro-stage: onboarding when pre-work",
  deriveMacroStage({ daily_recon_enabled: false, status: "onboarding", qbo_connected: false }) === "onboarding");

console.log(`\nclient-lifecycle: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
