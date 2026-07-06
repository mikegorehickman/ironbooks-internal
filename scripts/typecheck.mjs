#!/usr/bin/env node
/**
 * Ratcheting type-check gate.
 * ===========================
 *
 * The Next build intentionally sets `typescript.ignoreBuildErrors` because the
 * Supabase SDK's generated types produce a large pile of false-positive
 * inference errors ("never", RejectExcessProperties on .insert/.update, etc.)
 * on our views and `as any` payloads. Turning the build gate fully on today
 * would block every deploy on that noise.
 *
 * But "ignore ALL type errors" is how real bugs reached production (an
 * undefined `Sparkles` import, a missing `due_date` column reference — both
 * compiled fine and crashed at runtime). This script closes that gap WITHOUT
 * first cleaning the ~285-error legacy backlog:
 *
 *   - It runs `tsc --noEmit`, captures every error.
 *   - It compares against a committed baseline (scripts/tsc-baseline.json) of
 *     KNOWN pre-existing errors.
 *   - It FAILS only on errors that are NOT in the baseline — i.e. newly
 *     introduced ones. The backlog can be burned down over time; meanwhile
 *     nothing new slips in.
 *
 * Usage:
 *   node scripts/typecheck.mjs            # gate: exit 1 if any NEW error
 *   node scripts/typecheck.mjs --update   # regenerate the baseline (after an
 *                                         # intentional change to known errors)
 *
 * Signature = "<relpath>: error TSxxxx: <message>" with the (line,col) stripped
 * so a pre-existing error that merely shifts lines doesn't read as "new".
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "tsc-baseline.json");

function runTsc() {
  try {
    execSync("npx tsc --noEmit", { cwd: root, encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (e) {
    // tsc exits non-zero when there are errors; its report is on stdout.
    return (e.stdout || "") + (e.stderr || "");
  }
}

// "path(12,34): error TS2339: msg"  ->  "path: error TS2339: msg"
// Also sorts quoted-union listings ('"a" | "b"') inside the message: tsc
// emits union members in nondeterministic order between runs, which made
// identical pre-existing errors flap in and out of the exact-string baseline.
function toSignature(line) {
  return line
    .replace(/\(\d+,\d+\):/, ":")
    .replace(/"[^"]+"(?:\s*\|\s*(?:"[^"]+"|\.\.\. \d+ more \.\.\.))+/g, (m) =>
      /more \.\.\./.test(m)
        ? "<truncated-union>"
        : (m.match(/"[^"]+"/g) || []).sort().join(" | ")
    )
    .trim();
}

function collectSignatures(output) {
  const sigs = new Set();
  for (const line of output.split("\n")) {
    if (/: error TS\d+:/.test(line)) sigs.add(toSignature(line));
  }
  return sigs;
}

const output = runTsc();
const current = collectSignatures(output);

const update = process.argv.includes("--update");
if (update) {
  const sorted = [...current].sort();
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`✓ Wrote baseline: ${sorted.length} known type errors → scripts/tsc-baseline.json`);
  process.exit(0);
}

const baseline = existsSync(baselinePath)
  ? new Set(JSON.parse(readFileSync(baselinePath, "utf8")))
  : new Set();

const newErrors = [...current].filter((s) => !baseline.has(s));
const fixed = [...baseline].filter((s) => !current.has(s));

if (newErrors.length > 0) {
  console.error(`\n✗ ${newErrors.length} NEW TypeScript error(s) not in the baseline:\n`);
  for (const e of newErrors) console.error("  " + e);
  console.error(
    `\nFix them, or — if intentional — re-baseline with: npm run typecheck:update\n` +
      `(baseline currently tracks ${baseline.size} known pre-existing errors)\n`
  );
  process.exit(1);
}

console.log(
  `✓ No new type errors. ${current.size} known (baseline ${baseline.size}).` +
    (fixed.length ? ` ${fixed.length} baseline error(s) now fixed — run npm run typecheck:update to shrink the baseline.` : "")
);
process.exit(0);
