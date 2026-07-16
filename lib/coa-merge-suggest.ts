/**
 * Suggest the master account a non-master ("sprawl") account should merge
 * into — the "obvious" merges (Mike, 2026-07-16: "job supplies → job
 * supplies & materials"). Pure + deterministic; the bookkeeper confirms or
 * overrides every suggestion before anything runs, so this only needs to be
 * a helpful default, not perfect.
 *
 * Targets are the client's OWN accounts that already match a master name —
 * so a merge always lands on a real, standard account.
 *
 * Score = token overlap (Jaccard over significant words) + a substring bonus
 * (source name contained in target or vice-versa) + a small same-category
 * bonus. "confident" ≥ 0.5 pre-ticks the row; below that the bookkeeper
 * picks the target.
 */
import { normalizeAccountName } from "@/lib/account-name";
import { categorizeExpenseLine } from "@/lib/pl-categories";

export interface MergeTarget {
  id: string;
  name: string;
}

export interface MergeSuggestion {
  target: MergeTarget | null;
  score: number;
  confident: boolean;
}

// Words that carry no distinguishing signal for account matching.
const STOP = new Set(["and", "the", "of", "&", "-", "a", "expense", "expenses", "cost", "costs", "other", "general", "misc", "miscellaneous"]);

function tokens(name: string): Set<string> {
  return new Set(
    normalizeAccountName(name)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Best master-account target for one non-master account. */
export function suggestMergeTarget(
  sourceName: string,
  sourceIsCogs: boolean,
  targets: MergeTarget[]
): MergeSuggestion {
  const srcTokens = tokens(sourceName);
  const srcNorm = normalizeAccountName(sourceName);
  const srcCat = categorizeExpenseLine(sourceName, sourceIsCogs).key;

  let best: MergeTarget | null = null;
  let bestScore = 0;
  for (const t of targets) {
    const tNorm = normalizeAccountName(t.name);
    let score = jaccard(srcTokens, tokens(t.name));
    // Substring bonus — "job supplies" ⊂ "job supplies & materials".
    if (srcNorm && tNorm && (tNorm.includes(srcNorm) || srcNorm.includes(tNorm))) score += 0.35;
    // Same P&L category bonus (marketing→marketing, materials→materials).
    if (categorizeExpenseLine(t.name, sourceIsCogs).key === srcCat) score += 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }

  const score = Math.min(1, Math.round(bestScore * 100) / 100);
  return { target: best, score, confident: !!best && score >= 0.5 };
}
