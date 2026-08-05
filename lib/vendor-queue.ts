/** Vendor work-queue — the shared grouping / triage / split core.
 *  ---------------------------------------------------------------
 *  The reclass review's default view makes a VENDOR the unit of work instead of
 *  a transaction: one card, one account pick, "Approve N". This module is the
 *  pure half of that — grouping, triage state, and splitting — so the same
 *  logic can back the standalone review page, the monthly recon, and the bank
 *  rules export without three drifting copies.
 *
 *  WHY THE KEY MATTERS. Grouping uses the SAME key the bank-rule export
 *  consolidates on (known vendor brand → merchant stem → raw descriptor, see
 *  lib/rules-eligibility.ts). That makes a vendor card and a future bank rule
 *  the same object: whatever the bookkeeper decides on the card is exactly what
 *  a "contains <key>" rule will do next month. `merchantStemKey` guarantees the
 *  stem is a SUBSTRING of the descriptor, so the rule matches a superset of
 *  what the card showed — never a disjoint set.
 *
 *  SAFETY — the rule that cost real money once. Rows whose sender identifies
 *  nothing ("unknown vendor", "misc", blank) must NEVER share a card. On
 *  RocketPainter a naive normalizer collapsed 375 needs-review rows into 5
 *  cards, one holding $45,889 of unrelated "unknown vendor" transactions, where
 *  a single Approve would have mass-miscategorized. Each unidentifiable row
 *  gets its own card: one decision, one transaction. Correct, not convenient.
 */

import { merchantStemKey } from "./rules-eligibility";
import { extractKnownVendorName } from "./vendor-knowledge";

// ── Ungroupable senders ─────────────────────────────────────────────────────

/** Senders that identify nothing — never merged with anything else. */
export const UNGROUPABLE_SENDER =
  /^(unknown|unknown vendor|no vendor|n\/?a|misc|miscellaneous|none|null|\(no vendor\)|payment|deposit|withdrawal|transfer)$/i;

export function isUngroupableSender(sender: string | null | undefined): boolean {
  const s = String(sender || "").trim();
  return !s || UNGROUPABLE_SENDER.test(s);
}

// ── Triage state ────────────────────────────────────────────────────────────

/** Accounts that mean "we haven't actually decided yet". A target of one of
 *  these is not a classification — it's a parking spot, and the whole point of
 *  the unmatched filter is to find them.
 *
 *  Deliberately NOT matching on a bare "other" or "misc" prefix: "Other
 *  Income", "Other Expense" and "Miscellaneous Income" are real QBO accounts,
 *  and treating them as undecided would drag correctly-classified vendors back
 *  into the sweep forever. Those words only count when they ARE the whole name. */
const HOLDING_PREFIX =
  /^(uncategori[sz]ed|ask my accountant|suspense|unclassified|to be (determined|classified)|tbd)\b/i;
const HOLDING_EXACT = /^(other|misc|miscellaneous|unassigned|holding)$/i;

export type TargetState =
  | "unmatched"   // no target at all — no rule, no confident AI match
  | "holding"     // parked in Uncategorized / Ask My Accountant / Suspense
  | "set";        // a real account

export function classifyTarget(target: string | null | undefined): TargetState {
  const t = String(target || "").trim();
  if (!t) return "unmatched";
  if (HOLDING_PREFIX.test(t) || HOLDING_EXACT.test(t)) return "holding";
  return "set";
}

/** "Unmatched or unclassified" — the sweep filter. True when nothing has
 *  actually been decided: no target, or a holding account. */
export function needsClassification(target: string | null | undefined): boolean {
  return classifyTarget(target) !== "set";
}

// ── Grouping ────────────────────────────────────────────────────────────────

export interface QueueRow {
  id: string;
  /** Display sender, already extracted from vendor/description upstream. */
  sender: string;
  /** Raw descriptor the bank fed us — what a bank rule will match on. */
  descriptor: string;
  amount: number;
  /** Current target: bookkeeper override if present, else the AI's pick. */
  target: string | null;
  confidence?: number | null;
  reasoning?: string | null;
  flagged?: boolean;
}

export interface VendorGroup {
  /** Stable grouping key — also the bank-rule "contains" term when groupable. */
  key: string;
  /** Human label for the card. */
  display: string;
  /** False when this card is a single unidentifiable transaction. */
  groupable: boolean;
  rows: QueueRow[];
  count: number;
  /** Absolute dollars, for "biggest impact first". */
  total: number;
  /** The group's agreed target, or null when rows disagree / none set. */
  target: string | null;
  /** True when rows carry DIFFERENT targets — a split already in effect. */
  mixedTargets: boolean;
  targetState: TargetState;
  confidence: number | null;
  flagged: boolean;
  reasoning: string | null;
}

/**
 * The bank-rule-aligned key for a row. Brand first (the KB knows "Home Depot"
 * across a dozen descriptor spellings), then merchant stem, then the raw
 * descriptor. Returns groupable:false for senders that identify nothing, and
 * for those the caller must key by row id so they never merge.
 */
export function vendorKeyFor(row: Pick<QueueRow, "sender" | "descriptor">): {
  key: string;
  display: string;
  groupable: boolean;
} {
  if (isUngroupableSender(row.sender)) {
    return { key: "", display: row.sender || "(no vendor)", groupable: false };
  }
  const haystack = `${row.sender} ${row.descriptor || ""}`.trim();
  const brand = extractKnownVendorName(haystack);
  if (brand) return { key: brand.toUpperCase(), display: brand, groupable: true };
  const stem = merchantStemKey(row.sender) || merchantStemKey(row.descriptor || "");
  if (stem) return { key: stem.key, display: stem.display, groupable: true };
  const fallback = row.sender.trim();
  return { key: fallback.toUpperCase(), display: fallback, groupable: true };
}

export function groupByVendorKey(rows: QueueRow[]): VendorGroup[] {
  const map = new Map<string, VendorGroup>();
  for (const r of rows) {
    const { key, display, groupable } = vendorKeyFor(r);
    // Ungroupable rows get a per-row key so one card === one transaction.
    const mapKey = groupable ? `k:${key}` : `row:${r.id}`;
    const g = map.get(mapKey);
    if (!g) {
      map.set(mapKey, {
        key: groupable ? key : "",
        display,
        groupable,
        rows: [r],
        count: 1,
        total: Math.abs(r.amount || 0),
        target: r.target || null,
        mixedTargets: false,
        targetState: classifyTarget(r.target),
        confidence: r.confidence ?? null,
        reasoning: r.reasoning ?? null,
        flagged: !!r.flagged,
      });
      continue;
    }
    g.rows.push(r);
    g.count++;
    g.total = Math.round((g.total + Math.abs(r.amount || 0)) * 100) / 100;
    g.flagged = g.flagged || !!r.flagged;
    if (!g.target && r.target) g.target = r.target;
    // Lowest confidence in the group represents it — a card is only as sure as
    // its least sure row.
    if (r.confidence != null && (g.confidence == null || r.confidence < g.confidence)) {
      g.confidence = r.confidence;
    }
  }
  // Second pass: disagreement + state, which need the full row set.
  for (const g of map.values()) {
    const targets = new Set(g.rows.map((r) => (r.target || "").trim()).filter(Boolean));
    g.mixedTargets = targets.size > 1;
    // A group with any undecided row still needs classification — otherwise a
    // half-classified vendor would hide from the sweep filter.
    g.targetState = g.rows.some((r) => needsClassification(r.target))
      ? classifyTarget(g.rows.find((r) => needsClassification(r.target))!.target)
      : "set";
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** Cards where nothing has actually been decided yet. */
export function unclassifiedGroups(groups: VendorGroup[]): VendorGroup[] {
  return groups.filter((g) => g.targetState !== "set");
}

export type QueueSort = "impact" | "unclassified_first" | "least_confident" | "count";

export function sortGroups(groups: VendorGroup[], sort: QueueSort): VendorGroup[] {
  const out = [...groups];
  switch (sort) {
    case "unclassified_first":
      // Undecided first, then by dollars inside each bucket.
      return out.sort((a, b) => {
        const au = a.targetState !== "set" ? 0 : 1;
        const bu = b.targetState !== "set" ? 0 : 1;
        return au !== bu ? au - bu : b.total - a.total;
      });
    case "least_confident":
      // Nulls are "no opinion at all" — those come first, not last.
      return out.sort((a, b) => (a.confidence ?? -1) - (b.confidence ?? -1) || b.total - a.total);
    case "count":
      return out.sort((a, b) => b.count - a.count || b.total - a.total);
    case "impact":
    default:
      return out.sort((a, b) => b.total - a.total);
  }
}

// ── Splitting ───────────────────────────────────────────────────────────────

/**
 * One vendor, more than one answer. Two shapes, because these are the two the
 * books actually need:
 *
 *   amount_below   — fuel under $25 isn't a job fill-up, it's a jerry can.
 *   text_contains  — "AMAZON PRIME" is a subscription; plain "AMAZON" is materials.
 *
 * Both are expressible as QBO bank-rule conditions (description contains /
 * amount less than), which is the point: a split the bookkeeper makes here
 * survives as two rules next month instead of becoming manual work again.
 */
export type SplitRule =
  | { kind: "amount_below"; value: number; target: string | null }
  | { kind: "amount_atleast"; value: number; target: string | null }
  | { kind: "text_contains"; value: string; target: string | null };

export function splitRuleMatches(rule: SplitRule, row: QueueRow): boolean {
  const amt = Math.abs(row.amount || 0);
  switch (rule.kind) {
    case "amount_below":
      return amt < rule.value;
    case "amount_atleast":
      return amt >= rule.value;
    case "text_contains": {
      const needle = String(rule.value || "").trim().toUpperCase();
      if (!needle) return false;
      return `${row.sender} ${row.descriptor || ""}`.toUpperCase().includes(needle);
    }
  }
}

export function describeSplitRule(rule: SplitRule): string {
  switch (rule.kind) {
    case "amount_below":
      return `under $${rule.value}`;
    case "amount_atleast":
      return `$${rule.value} and over`;
    case "text_contains":
      return `contains "${rule.value}"`;
  }
}

export interface SplitBucket {
  rule: SplitRule | null; // null = the leftover bucket
  label: string;
  rows: QueueRow[];
  total: number;
}

/**
 * Apply splits in order — FIRST match wins, so overlapping rules are
 * deterministic rather than double-counting a row. Every row lands in exactly
 * one bucket; whatever no rule claims falls to "everything else", which keeps
 * the vendor's original target.
 */
export function applySplit(rows: QueueRow[], rules: SplitRule[]): SplitBucket[] {
  const buckets: SplitBucket[] = rules.map((rule) => ({
    rule,
    label: describeSplitRule(rule),
    rows: [],
    total: 0,
  }));
  const leftover: SplitBucket = { rule: null, label: "Everything else", rows: [], total: 0 };

  for (const r of rows) {
    const hit = buckets.find((b) => b.rule && splitRuleMatches(b.rule, r)) || leftover;
    hit.rows.push(r);
    hit.total = Math.round((hit.total + Math.abs(r.amount || 0)) * 100) / 100;
  }
  // Drop rules that caught nothing — an empty bucket is noise, not information.
  const kept = buckets.filter((b) => b.rows.length > 0);
  return leftover.rows.length > 0 ? [...kept, leftover] : kept;
}

export interface SplitSuggestion {
  rule: SplitRule;
  /** Why we're offering it, in the bookkeeper's terms. */
  why: string;
  matches: number;
}

const SPLIT_THRESHOLDS = [25, 50, 100, 250];
/** Words that distinguish a sub-brand, not a store number or city. */
const VARIANT_STOPWORDS = new Set([
  "INC", "LLC", "LTD", "CO", "CORP", "THE", "AND", "OF", "STORE", "PURCHASE",
  "PAYMENT", "POS", "DEBIT", "CARD", "VISA", "MASTERCARD", "INTERAC", "CONTACTLESS",
]);

/**
 * Offer splits worth a bookkeeper's attention — never apply them. Two probes:
 *
 *  1. A descriptor token that appears in SOME rows and not others (the Amazon /
 *     Amazon Prime case). Requires ≥2 on each side so a single oddity doesn't
 *     generate a rule.
 *  2. A round dollar threshold with real rows on both sides (the fuel case).
 *     Picks the most balanced threshold rather than the first that "works".
 *
 * Only suggests for groups big enough to be worth splitting (≥4 rows).
 */
export function suggestSplits(group: VendorGroup): SplitSuggestion[] {
  const out: SplitSuggestion[] = [];
  const rows = group.rows;
  if (!group.groupable || rows.length < 4) return out;

  // ── 1. Descriptor variants ──
  const keyWords = new Set(group.key.split(/[^A-Z0-9]+/).filter(Boolean));
  const tokenRows = new Map<string, number>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const w of `${r.sender} ${r.descriptor || ""}`.toUpperCase().split(/[^A-Z0-9]+/)) {
      if (w.length < 3 || seen.has(w)) continue;
      if (keyWords.has(w) || VARIANT_STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
      seen.add(w);
      tokenRows.set(w, (tokenRows.get(w) || 0) + 1);
    }
  }
  for (const [word, n] of [...tokenRows.entries()].sort((a, b) => b[1] - a[1])) {
    if (n < 2 || rows.length - n < 2) continue;
    out.push({
      rule: { kind: "text_contains", value: word, target: null },
      why: `${n} of ${rows.length} transactions say "${word}" — those may belong somewhere else`,
      matches: n,
    });
    if (out.length >= 2) break; // two variant offers is plenty of screen
  }

  // ── 2. Amount threshold ──
  let best: { t: number; below: number; balance: number } | null = null;
  for (const t of SPLIT_THRESHOLDS) {
    const below = rows.filter((r) => Math.abs(r.amount || 0) < t).length;
    const above = rows.length - below;
    if (below < 2 || above < 2) continue;
    const balance = Math.min(below, above) / rows.length; // higher = more even
    if (!best || balance > best.balance) best = { t, below, balance };
  }
  if (best) {
    out.push({
      rule: { kind: "amount_below", value: best.t, target: null },
      why: `${best.below} of ${rows.length} are under $${best.t} — small ones often aren't the same expense`,
      matches: best.below,
    });
  }

  return out;
}
