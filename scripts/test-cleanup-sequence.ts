/**
 * Unit tests for lib/cleanup-sequence.ts — status merge, active step, progress.
 * Run: npx tsx scripts/test-cleanup-sequence.ts
 */
import {
  CLEANUP_STEPS,
  readCleanupSequence,
  effectiveStepStatus,
  activeCleanupStep,
  cleanupProgress,
  isCleanupStepKey,
  isCleanupStepStatus,
} from "../lib/cleanup-sequence";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// 8 ordered steps.
ok("8 steps defined", CLEANUP_STEPS.length === 8);
ok("steps numbered 1..8", CLEANUP_STEPS.every((s, i) => s.num === i + 1));
ok("first step is foundation", CLEANUP_STEPS[0].key === "foundation");
ok("last step is verify", CLEANUP_STEPS[7].key === "verify");
ok("every step has at least one tool", CLEANUP_STEPS.every((s) => s.tools.length >= 1));
ok(
  "each tool has exactly one of href/tab",
  CLEANUP_STEPS.every((s) => s.tools.every((t) => !!t.href !== !!t.tab))
);

// Guards.
ok("isCleanupStepKey accepts coa", isCleanupStepKey("coa"));
ok("isCleanupStepKey rejects junk", !isCleanupStepKey("nope"));
ok("isCleanupStepStatus accepts done", isCleanupStepStatus("done"));
ok("isCleanupStepStatus rejects junk", !isCleanupStepStatus("finished"));

// readCleanupSequence normalization.
const empty = readCleanupSequence(null);
ok("empty row → no steps", Object.keys(empty.steps).length === 0);
const malformed = readCleanupSequence({ cleanup_sequence: { steps: { coa: { status: "bogus" } } } });
ok("malformed status dropped", malformed.steps.coa === undefined);
const good = readCleanupSequence({ cleanup_sequence: { steps: { coa: { status: "done", note: "x" } } } });
ok("valid status kept", good.steps.coa?.status === "done");

// effectiveStepStatus: manual override wins.
ok(
  "manual mark wins",
  effectiveStepStatus(good, "coa", { cleanupCompletedAt: null }) === "done"
);
ok(
  "unmarked step is pending",
  effectiveStepStatus(good, "rules", { cleanupCompletedAt: null }) === "pending"
);
// cleanupCompletedAt auto-derives every unmarked step to done.
ok(
  "completed cleanup → verify done",
  effectiveStepStatus(empty, "verify", { cleanupCompletedAt: "2026-07-01" }) === "done"
);

// activeCleanupStep: first non-done/skipped.
const partial = readCleanupSequence({
  cleanup_sequence: { steps: { foundation: { status: "done" }, coa: { status: "skipped" } } },
});
ok("active skips done+skipped", activeCleanupStep(partial) === "categorize");
ok(
  "all done → no active step",
  activeCleanupStep(empty, { cleanupCompletedAt: "2026-07-01" }) === null
);

// progress counts done + skipped.
ok("partial progress = 2/8", cleanupProgress(partial).done === 2);
ok(
  "completed cleanup = 8/8",
  cleanupProgress(empty, { cleanupCompletedAt: "2026-07-01" }).done === 8
);
ok("empty progress = 0/8", cleanupProgress(empty).done === 0);

console.log(`\ncleanup-sequence: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
