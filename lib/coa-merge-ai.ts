/**
 * AI-backed COA merge suggestions (Mike, 2026-07-16: "use an AI engine to make
 * these recommendations better — some were good though").
 *
 * The old token-Jaccard heuristic (lib/coa-merge-suggest) forced a best-match
 * target onto EVERY non-master account, so vehicles/trailers (fixed assets),
 * bank/credit-card accounts, and A/R–A/P all got dumped into whatever scored
 * least-badly (in practice "Charitable Giving"). This asks Claude to reason
 * about accounting MEANING + type compatibility and, crucially, to return
 * action:"leave" for anything that is not a P&L/equity merge candidate.
 *
 * Rules the model must follow (enforced again in code after the call):
 *   - Only Income / Cost of Goods Sold / Expense / Other Income / Other
 *     Expense / (owner) Equity accounts are merge candidates. Bank, Credit
 *     Card, Accounts Receivable/Payable, Fixed Asset, Other Asset, and any
 *     Liability/loan account → action:"leave" (never a merge here).
 *   - A source may only merge into a target of a COMPATIBLE type: income→income,
 *     expense→expense/COGS, equity→equity. Never cross income↔expense.
 *   - Choose a target ONLY from the supplied list of the client's real
 *     master-standard accounts. If none clearly fits, action:"leave" — do NOT
 *     force a weak match.
 */
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-8";

export interface AiMergeSource {
  id: string;
  name: string;
  type: string; // QBO AccountType
}
export interface AiMergeTarget {
  id: string;
  name: string;
  type: string; // QBO AccountType of the master-standard account
}
export interface AiMergeSuggestion {
  sourceId: string;
  action: "merge" | "leave";
  targetId: string | null;
  targetName: string | null;
  confidence: number; // 0–1
  reason: string;
}

// QBO AccountTypes that can ever be a P&L/equity merge candidate. Everything
// else (banks, cards, receivables/payables, assets, liabilities/loans) is left
// alone — this tool never merges balance-sheet operating accounts.
const MERGEABLE_TYPES = new Set([
  "Income",
  "Other Income",
  "Cost of Goods Sold",
  "Expense",
  "Other Expense",
  "Equity",
]);

// Broad type family for compatibility checks (income vs expense vs equity).
function typeFamily(qboType: string): "income" | "expense" | "equity" | "other" {
  const t = (qboType || "").toLowerCase();
  if (t === "income" || t === "other income") return "income";
  if (t === "expense" || t === "other expense" || t === "cost of goods sold") return "expense";
  if (t === "equity") return "equity";
  return "other";
}

const SYSTEM_PROMPT = `You are a senior bookkeeper standardizing a QuickBooks Online chart of accounts for a painting/trades contractor. You are given a list of the client's NON-STANDARD accounts and a list of the STANDARD (master) accounts that already exist in their file. For each non-standard account decide whether it should be MERGED into one standard account, or LEFT alone.

Merging moves every transaction from the source account onto the target and deactivates the source. Only suggest a merge when it is clearly, obviously correct to a professional bookkeeper.

HARD RULES:
1. Only Income, Other Income, Cost of Goods Sold, Expense, and Other Expense accounts — plus owner Equity draw/contribution accounts — can be merge candidates. For ANY account that is a Bank, Credit Card, Accounts Receivable, Accounts Payable, Fixed Asset (vehicles, trailers, equipment like sprayers/"Graco 695"), Other Asset, or any Liability/loan, ALWAYS return action "leave" — these are real balance-sheet accounts, not chart sprawl.
2. A source may only merge into a target of a COMPATIBLE type: an income account only into an income target; an expense/COGS account only into an expense or COGS target; an equity account only into an equity target. NEVER merge income into expense or vice-versa.
3. Choose the target ONLY from the provided standard-accounts list, by exact name. If no standard account is clearly the right home, return action "leave" — do NOT force a weak or generic match. It is much better to leave an account alone than to merge it into the wrong place.
4. Judge by accounting MEANING, not text similarity. Examples: hardware/lumber vendors like "Lowes", "Menards", "Home Depot", "Fleet Farm", "Rona" that are expense/COGS accounts → the job materials account. "Insurance Expense" / "General Liability Insurance" → Insurance. "Owner Draw / Salary" / "Owner's Distribution" → the owner's draw/contribution equity account. "Online Advertising", "Marketing Tools" → Marketing.

Return ONLY a JSON object, no prose, no markdown fences:
{"suggestions":[{"sourceId":"<id>","action":"merge"|"leave","targetName":"<exact standard account name or null>","confidence":<0-1>,"reason":"<short reason>"}]}
Include EVERY source id exactly once. Use confidence >= 0.85 only when the merge is unambiguous.`;

/**
 * Ask Claude to map each non-master account to a standard target (or leave it).
 * Returns one suggestion per source, validated + type-guarded in code so a
 * hallucinated / incompatible target can never surface as a "merge".
 */
export async function suggestMergesWithAI(
  sources: AiMergeSource[],
  targets: AiMergeTarget[]
): Promise<AiMergeSuggestion[]> {
  if (sources.length === 0) return [];

  const targetByName = new Map(targets.map((t) => [t.name.toLowerCase(), t]));

  const userMessage = `STANDARD ACCOUNTS (valid merge targets — choose targetName from these exact names):
${targets.length ? targets.map((t) => `- ${t.name}  [${t.type}]`).join("\n") : "(none — every account must be action \"leave\")"}

NON-STANDARD ACCOUNTS to classify:
${sources.map((s) => `- id=${s.id} | ${s.name}  [${s.type}]`).join("\n")}`;

  let parsed: { suggestions?: Array<{ sourceId: string; action: string; targetName: string | null; confidence: number; reason: string }> };
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("no text response");
    const cleaned = textBlock.text.trim().replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    throw new Error(`AI merge suggestion failed: ${err.message}`);
  }

  return reconcileAiSuggestions(parsed.suggestions || [], sources, targets);
}

/**
 * Pure, deterministic guard over whatever the model returned — the actual
 * safety layer, exhaustively unit-tested (no API key needed). Guarantees,
 * regardless of what the model says:
 *   - a non-P&L/equity source (bank, card, A/R–A/P, asset, loan) is ALWAYS left;
 *   - a "merge" only survives if its target is a real supplied target AND
 *     type-compatible (never income↔expense↔equity crossing);
 *   - every source appears exactly once.
 */
export function reconcileAiSuggestions(
  rawSuggestions: Array<{ sourceId: string; action: string; targetName: string | null; confidence: number; reason: string }>,
  sources: AiMergeSource[],
  targets: AiMergeTarget[]
): AiMergeSuggestion[] {
  const targetByName = new Map(targets.map((t) => [t.name.toLowerCase(), t]));
  const bySourceId = new Map(rawSuggestions.map((s) => [String(s.sourceId), s]));

  return sources.map((src): AiMergeSuggestion => {
    const raw = bySourceId.get(src.id);
    const srcMergeable = MERGEABLE_TYPES.has(src.type);

    // No answer, or source isn't a mergeable account type → leave.
    if (!raw || raw.action !== "merge" || !srcMergeable) {
      return {
        sourceId: src.id,
        action: "leave",
        targetId: null,
        targetName: null,
        confidence: raw?.confidence ?? 0,
        reason: !srcMergeable
          ? `${src.type} account — not COA sprawl; left as-is`
          : raw?.reason || "No clear standard account to merge into",
      };
    }

    // Validate the chosen target exists and is type-compatible.
    const tgt = raw.targetName ? targetByName.get(raw.targetName.toLowerCase()) : undefined;
    const compatible = tgt && typeFamily(tgt.type) === typeFamily(src.type);
    if (!tgt || !compatible) {
      return {
        sourceId: src.id,
        action: "leave",
        targetId: null,
        targetName: null,
        confidence: 0,
        reason: tgt
          ? `Skipped: "${tgt.name}" (${tgt.type}) is not type-compatible with ${src.name} (${src.type})`
          : "AI picked a target that isn't a standard account — left as-is",
      };
    }

    return {
      sourceId: src.id,
      action: "merge",
      targetId: tgt.id,
      targetName: tgt.name,
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.7,
      reason: raw.reason || "",
    };
  });
}
