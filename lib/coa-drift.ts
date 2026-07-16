/**
 * Read-only COA drift report — "how far is this client's live QBO chart from
 * the master COA?" (Mike, 2026-07-16: make sure the master COA is actually
 * applied to every client). Pure + deterministic; no QBO writes, no AI. The
 * fleet audit route feeds it live accounts + the master rows and shows the
 * per-client conformance so we can triage the standardization pass.
 *
 * Four buckets per client:
 *   - matched     : an active account whose name AND type match a master row
 *   - wrongType   : name matches master but AccountType/SubType differ
 *                   (would sit in the wrong statement section) — safe,
 *                   deterministic retype (reuses computeRetypePlans)
 *   - nonMaster   : an active P&L/BS account NOT in the master at all —
 *                   the merge/rename candidates (the sprawl)
 *   - missingReq  : required master leaves the client is missing entirely
 */
import { normalizeAccountName } from "@/lib/account-name";
import { computeRetypePlans, type RetypeMasterRow, type RetypeClientAccount } from "@/lib/coa-retype";

export interface DriftMasterRow extends RetypeMasterRow {
  parent_account_name: string | null;
  is_parent: boolean;
  is_required?: boolean | null;
}

export interface DriftAccount extends RetypeClientAccount {
  Classification?: string;
  Active?: boolean;
}

export interface CoaDrift {
  totalActive: number;      // active P&L/BS accounts considered
  matched: number;
  wrongType: { id: string; name: string; currentType: string; masterType: string }[];
  nonMaster: { name: string; type: string }[];
  missingRequired: string[];
  /** 0–100: matched ÷ (accounts that map to a master name). Higher = more
   *  conformant. Non-master accounts drag it down. */
  conformancePct: number;
}

// Only P&L + balance-sheet accounts matter for the chart standard; skip the
// QBO system accounts that every file carries and we never standardize.
const SKIP_NAME = /^(uncategorized|ask my accountant|opening balance equity|retained earnings|reconciliation discrepan|undeposited funds)/i;

export function computeCoaDrift(accounts: DriftAccount[], masterRows: DriftMasterRow[]): CoaDrift {
  const masterLeafByNorm = new Map<string, DriftMasterRow>();
  for (const m of masterRows) {
    if (!m.account_name) continue;
    masterLeafByNorm.set(normalizeAccountName(m.account_name), m);
  }

  const active = accounts.filter(
    (a) => a.Active !== false && !SKIP_NAME.test((a.Name || "").trim())
  );

  // Wrong-type via the deterministic retype engine (name matches master,
  // type/subtype differ).
  const retypeById = new Map(
    computeRetypePlans({ masterRows, clientAccounts: active }).map((p) => [p.qbo_account_id, p])
  );

  let matched = 0;
  const wrongType: CoaDrift["wrongType"] = [];
  const nonMaster: CoaDrift["nonMaster"] = [];

  for (const a of active) {
    const norm = normalizeAccountName(a.Name);
    const inMaster = masterLeafByNorm.has(norm);
    const rt = retypeById.get(a.Id);
    if (inMaster && rt) {
      wrongType.push({ id: a.Id, name: a.Name, currentType: rt.current_type || "(none)", masterType: rt.new_type });
    } else if (inMaster) {
      matched++;
    } else {
      nonMaster.push({ name: a.Name, type: a.AccountType || "(none)" });
    }
  }

  // Missing REQUIRED master leaves (parents aren't line accounts).
  const clientNorms = new Set(active.map((a) => normalizeAccountName(a.Name)));
  const missingRequired = masterRows
    .filter((m) => !m.is_parent && m.is_required && !clientNorms.has(normalizeAccountName(m.account_name)))
    .map((m) => m.account_name);

  const mappable = matched + wrongType.length; // accounts that hit a master name
  const denom = mappable + nonMaster.length;
  const conformancePct = denom > 0 ? Math.round((matched / denom) * 100) : 100;

  return {
    totalActive: active.length,
    matched,
    wrongType,
    nonMaster,
    missingRequired,
    conformancePct,
  };
}
