// Tests for the 3-macro-stage lifecycle spine.
// Run: npx tsx scripts/test-macro-stage.ts
import {
  deriveMacroStage, macroStageOfStatus, deriveLifecycleStatus,
  type LifecycleInput, type LifecycleStatus,
} from "@/lib/client-lifecycle";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

// ── deriveMacroStage from raw signals ──
ok(deriveMacroStage({ status: "onboarding", qbo_connected: false }) === "onboarding", "new won client, not connected → onboarding");
ok(deriveMacroStage({ status: "onboarding", qbo_connected: true }) === "cleanup", "connected → cleanup (foundation aside)");
ok(deriveMacroStage({ status: "onboarding", qbo_connected: false, has_active_coa: true }) === "cleanup", "cleanup work started → cleanup even if not connected flag");
ok(deriveMacroStage({ has_active_reclass: true }) === "cleanup", "reclass in flight → cleanup");
ok(deriveMacroStage({ cleanup_review_state: "in_review" }) === "cleanup", "cleanup in review → cleanup");
ok(deriveMacroStage({ cleanup_completed_at: "2026-06-01" }) === "cleanup", "cleanup done, not promoted → cleanup");
ok(deriveMacroStage({ cleanup_completed_at: "2026-06-01", daily_recon_enabled: true }) === "production", "signed off + daily recon → production");
ok(deriveMacroStage({ daily_recon_enabled: true }) === "cleanup", "daily recon but NOT cleanup-complete → still cleanup (not production)");
ok(deriveMacroStage({}) === "cleanup", "empty/unknown → cleanup default (never strands in onboarding)");

// ── status ↔ macro stage agreement ──
const cases: Array<{ input: LifecycleInput }> = [
  { input: { status: "onboarding", qbo_connected: false } },
  { input: { has_active_coa: true } },
  { input: { has_complete_reclass: true, bs_deferred: true } },
  { input: { cleanup_completed_at: "2026-06-01", daily_recon_enabled: true, month_done: true } },
  { input: { cleanup_completed_at: "2026-06-01", daily_recon_enabled: true } },
];
for (const { input } of cases) {
  const status = deriveLifecycleStatus(input);
  const stageFromInput = deriveMacroStage(input);
  // For the unambiguous statuses, macroStageOfStatus should match deriveMacroStage.
  if (["onboarding", "in_production", "done"].includes(status)) {
    ok(macroStageOfStatus(status) === stageFromInput, `status ${status}: status-map and input-derive agree`);
  }
}

// macroStageOfStatus direct
ok(macroStageOfStatus("onboarding") === "onboarding", "map: onboarding");
ok(macroStageOfStatus("in_production") === "production", "map: in_production");
ok(macroStageOfStatus("done") === "production", "map: done");
ok(macroStageOfStatus("coa_cleanup") === "cleanup", "map: coa_cleanup → cleanup");
ok(macroStageOfStatus("ready_for_review") === "cleanup", "map: ambiguous review → cleanup default");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
