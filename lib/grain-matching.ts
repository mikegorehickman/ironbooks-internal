/**
 * Grain ↔ client matching engine (pure logic; no network).
 *
 * Used by the backfill and by the admin Call Matching tab. Given a recording's
 * participants, the active client roster, and the learned rules, it decides
 * which client(s) a recording belongs to. A single (group) call can match
 * several clients.
 *
 * Match precedence (strongest first): manual > rule > email > name.
 * - manual: a bookkeeper picked it in the Call Matching tab.
 * - rule:   a learned rule (from a prior manual match) matched a participant.
 * - email:  a participant email == client_email or a portal-login email.
 * - name:   a participant name matches the client's contact or business name.
 */

export type MatchMethod = "auto_email" | "auto_name" | "auto_rule" | "manual";

export interface MatchClient {
  id: string;
  client_name: string;
  client_email: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  portal_emails?: string[];
}

export interface MatchRule {
  rule_type: "email" | "name" | "domain";
  match_value: string;
  client_link_id: string;
}

export interface MatchParticipant {
  name: string | null;
  email: string | null;
  scope: string | null;
}

const IRONBOOKS_DOMAIN = "ironbooks.com";

export function emailDomain(email: string | null | undefined): string {
  return (email || "").split("@")[1]?.toLowerCase() || "";
}

export function isIronbooks(email: string | null | undefined): boolean {
  return emailDomain(email) === IRONBOOKS_DOMAIN;
}

/** Normalize a person/business name for comparison. */
export function normName(s: string | null | undefined): string {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(llc|inc|incorporated|ltd|limited|corp|corporation|company|co|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Tokens (length ≥ 3) of a normalized name, dropping generic trade words. */
const GENERIC = new Set(["painting", "painters", "paint", "services", "service", "contracting", "construction", "home", "improvement", "design", "decorating", "renovations", "renovation", "pros", "pro"]);
function distinctiveTokens(s: string): string[] {
  return normName(s).split(" ").filter((t) => t.length >= 3 && !GENERIC.has(t));
}

/**
 * Match a recording's participants to clients. Returns a map of
 * client_link_id → strongest MatchMethod. Only non-ironbooks participants
 * are considered for the client side.
 */
export function matchRecording(
  participants: MatchParticipant[],
  clients: MatchClient[],
  rules: MatchRule[]
): Map<string, MatchMethod> {
  const result = new Map<string, MatchMethod>();
  const rank: Record<MatchMethod, number> = { manual: 4, auto_rule: 3, auto_email: 2, auto_name: 1 };
  const consider = (clientId: string, method: MatchMethod) => {
    const cur = result.get(clientId);
    if (!cur || rank[method] > rank[cur]) result.set(clientId, method);
  };

  // Pre-index rules.
  const emailRules = new Map<string, string[]>(); // email → clientIds
  const nameRules = new Map<string, string[]>();   // normName → clientIds
  for (const r of rules) {
    const map = r.rule_type === "email" ? emailRules : r.rule_type === "name" ? nameRules : null;
    if (!map) continue;
    const arr = map.get(r.match_value) || [];
    arr.push(r.client_link_id);
    map.set(r.match_value, arr);
  }

  // Pre-index clients by email + portal emails.
  const emailToClient = new Map<string, string>();
  for (const c of clients) {
    for (const e of [c.client_email, ...(c.portal_emails || [])]) {
      if (e) emailToClient.set(e.toLowerCase(), c.id);
    }
  }

  for (const p of participants) {
    const pe = (p.email || "").toLowerCase();
    if (pe && isIronbooks(pe)) continue; // ironbooks host is never the client
    const pn = normName(p.name);

    // 1. rules
    if (pe) for (const cid of emailRules.get(pe) || []) consider(cid, "auto_rule");
    if (pn) for (const cid of nameRules.get(pn) || []) consider(cid, "auto_rule");

    // 2. email == client email / portal email
    if (pe && emailToClient.has(pe)) consider(emailToClient.get(pe)!, "auto_email");

    // 3. name match (conservative: full contact-name match, or distinctive
    //    business-name token overlap — avoids matching on "painting" etc.)
    if (pn) {
      for (const c of clients) {
        const contact = normName([c.contact_first_name, c.contact_last_name].filter(Boolean).join(" "));
        if (contact && contact.length > 4 && (pn === contact || pn.includes(contact) || contact.includes(pn))) {
          consider(c.id, "auto_name");
          continue;
        }
        const bizTokens = distinctiveTokens(c.client_name);
        const pnTokens = pn.split(" ");
        if (bizTokens.length && bizTokens.every((t) => pnTokens.includes(t))) {
          consider(c.id, "auto_name");
        }
      }
    }
  }

  return result;
}

/**
 * Build the rules to persist when a recording is manually matched to a client.
 * Creates an email rule for each non-ironbooks participant email and a name
 * rule for each distinct participant name, so future calls with the same
 * person auto-match.
 */
export function rulesFromManualMatch(
  participants: MatchParticipant[],
  clientLinkId: string
): MatchRule[] {
  const rules: MatchRule[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    const pe = (p.email || "").toLowerCase();
    if (pe && !isIronbooks(pe) && !seen.has("e:" + pe)) {
      seen.add("e:" + pe);
      rules.push({ rule_type: "email", match_value: pe, client_link_id: clientLinkId });
    }
    const pn = normName(p.name);
    if (pn && pn.length > 4 && !isIronbooks(pe) && !seen.has("n:" + pn)) {
      seen.add("n:" + pn);
      rules.push({ rule_type: "name", match_value: pn, client_link_id: clientLinkId });
    }
  }
  return rules;
}
