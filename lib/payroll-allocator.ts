/**
 * Payroll allocator — splits a lump "Payroll"/"Wages" expense account into the
 * master-COA cost structure:
 *
 *   field crew   → Direct Field Labor            (COGS — scales with jobs)
 *   owner        → Owner's Payroll               (opex)
 *   ops manager  → Ops Manager Payroll           (opex)
 *   admin/office → Admin Payroll                 (opex)
 *
 * Method: aggregate the payroll postings by PAYEE, classify each payee's role
 * (owner = deterministic name-match against the client contact; everyone else
 * = a cheap Haiku call over the payee list), and emit one reallocation JE per
 * payee bucket. Unknowns are flagged, never guessed into COGS.
 *
 * Pure computation + one AI call; posting stays approval-gated in the module.
 */

import Anthropic from "@anthropic-ai/sdk";

export type PayrollRole = "field" | "owner" | "manager" | "admin" | "unknown";

export interface PayeeTotal {
  payee: string;
  total: number;
  txnCount: number;
}

export interface PayeeClassification {
  payee: string;
  total: number;
  txnCount: number;
  role: PayrollRole;
  confidence: number;
  reason: string;
}

export const ROLE_TARGET_HINTS: Record<Exclude<PayrollRole, "unknown">, string> = {
  field: "Direct Field Labor",
  owner: "Owner's Payroll",
  manager: "Ops Manager Payroll",
  admin: "Admin Payroll",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/** Deterministic owner detection: payee shares first+last (or a full token
 *  match on an uncommon name) with the client contact. */
export function looksLikeOwner(payee: string, ownerNames: string[]): boolean {
  const p = norm(payee);
  if (!p) return false;
  for (const owner of ownerNames) {
    const o = norm(owner);
    if (!o) continue;
    if (p === o) return true;
    const oTokens = o.split(" ").filter((t) => t.length > 1);
    if (oTokens.length >= 2 && oTokens.every((t) => p.includes(t))) return true;
  }
  return false;
}

/** Group payroll transactions (payee + amount) into per-payee totals. */
export function aggregateByPayee(
  txns: Array<{ payee: string | null; amount: number }>,
  minTotal = 100
): PayeeTotal[] {
  const map = new Map<string, PayeeTotal>();
  for (const t of txns) {
    const key = (t.payee || "").trim() || "(no payee)";
    const cur = map.get(key) || { payee: key, total: 0, txnCount: 0 };
    cur.total = Math.round((cur.total + t.amount) * 100) / 100;
    cur.txnCount++;
    map.set(key, cur);
  }
  return [...map.values()]
    .filter((p) => p.total >= minTotal)
    .sort((a, b) => b.total - a.total);
}

/**
 * Classify payees. Owner matches are deterministic (0.95); the rest go to
 * Haiku in one batch. On any AI failure everyone non-owner returns "unknown"
 * so the module flags instead of guessing.
 */
export async function classifyPayees(
  payees: PayeeTotal[],
  ownerNames: string[],
  clientCompany: string
): Promise<PayeeClassification[]> {
  const out: PayeeClassification[] = [];
  const forAi: PayeeTotal[] = [];

  for (const p of payees) {
    if (looksLikeOwner(p.payee, ownerNames)) {
      out.push({ ...p, role: "owner", confidence: 0.95, reason: "matches client owner name" });
    } else if (/payroll|adp|wagepoint|gusto|ceridian|quickbooks payroll|wave|paychex/i.test(p.payee)) {
      // A payroll PROVIDER as payee = bulk runs, not a person — can't split by
      // name. Flag it; the fix is per-employee data from the provider.
      out.push({ ...p, role: "unknown", confidence: 0, reason: "payroll provider bulk payment — needs per-employee report" });
    } else {
      forAi.push(p);
    }
  }

  if (forAi.length > 0) {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system:
          'You classify payroll payees for a painting contractor\'s books. Roles: "field" (painters/crew/labourers — the default for person names at a painting company), "manager" (ops/production manager), "admin" (office/bookkeeping/reception), "unknown" (can\'t tell / not a person). Return STRICT JSON only: [{"payee": string, "role": string, "confidence": number 0-1, "reason": string under 8 words}]. Copy payee EXACTLY. Confidence ≤ 0.85 unless the name itself signals the role.',
        messages: [
          {
            role: "user",
            content: `Company: ${clientCompany} (painting contractor)\nPayees on the payroll expense account (name · total paid · # payments):\n${forAi
              .slice(0, 40)
              .map((p) => `${p.payee} · $${p.total.toFixed(0)} · ${p.txnCount}`)
              .join("\n")}`,
          },
        ],
      });
      const text = resp.content[0]?.type === "text" ? resp.content[0].text : "[]";
      const parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
      const byPayee = new Map<string, any>(
        (Array.isArray(parsed) ? parsed : []).map((r: any) => [String(r.payee || ""), r])
      );
      for (const p of forAi) {
        const r = byPayee.get(p.payee);
        const role: PayrollRole = ["field", "manager", "admin", "owner"].includes(r?.role)
          ? r.role
          : "unknown";
        out.push({
          ...p,
          role,
          confidence: role === "unknown" ? 0 : Math.min(0.85, Number(r?.confidence) || 0.7),
          reason: String(r?.reason || "AI classification").slice(0, 60),
        });
      }
    } catch {
      for (const p of forAi) {
        out.push({ ...p, role: "unknown", confidence: 0, reason: "AI classification unavailable" });
      }
    }
  }

  return out.sort((a, b) => b.total - a.total);
}

/** Field share of classified wages — drives the employer-tax pro-rata split. */
export function fieldWageRatio(classified: PayeeClassification[]): number {
  const known = classified.filter((c) => c.role !== "unknown");
  const total = known.reduce((s, c) => s + c.total, 0);
  if (total <= 0) return 0;
  const field = known.filter((c) => c.role === "field").reduce((s, c) => s + c.total, 0);
  return Math.round((field / total) * 1000) / 1000;
}
