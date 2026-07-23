/**
 * COA-merge JE audit — read-only inventory of the lump journal entries the COA
 * merge tool posted when QBO's API couldn't reclassify the underlying lines
 * (payroll checks, deposits, income). Those JEs collapse per-transaction GL
 * detail into one net line on the target account. This finds them so they can
 * be reviewed and reversed. NOTHING here writes to QBO.
 *
 * See memory: ironbooks-coa-merge-je-remediation. Root cause:
 * lib/coa-reclass-je.ts reclassAccountViaJournalEntry (per-month 2-line JE),
 * invoked as a merge sweep in lib/executor.ts.
 */
import { qboRequest } from "@/lib/qbo";
import { normalizeAccountName } from "@/lib/account-name";

/** Memo/description fingerprints the merge engine stamped on its JEs, across
 *  both eras (older "SNAP COA merge …", current "Ironbooks merge (JE sweep) …").
 *  Matched case-insensitively against PrivateNote AND each line's Description. */
export const MERGE_JE_FINGERPRINTS = [
  "snap coa merge",
  "ironbooks merge (je sweep)",
  "ironbooks merge",
  "coa merge",
];

/** Clients Mike confirmed are NOT affected — never scanned/touched. */
export const MERGE_JE_EXCLUDED_CLIENTS = ["san diego custom painting", "premier pro"];

/** The accounts detail was collapsed on (source/target of the affected merges). */
export const MERGE_JE_AFFECTED_ACCOUNTS = [
  "Direct Labour - Painting",
  "Direct Labour - Taxes",
  "Job Supplies",
  "Paint and Materials",
  "Owner Salary",
  "Owner Salary Employer Taxes",
  "Admin Team Salaries",
  "Fuel - Admin & Sales Vehicles",
  "Repairs - Admin & Sales Vehicles",
];

export interface MergeJeLine {
  accountId: string | null;
  accountName: string;
  posting: "Debit" | "Credit";
  amount: number;
}

export interface MergeJeRow {
  jeId: string;
  txnDate: string;
  privateNote: string;
  totalAmount: number;
  lines: MergeJeLine[];
  /** account names on this JE that are in the affected list. */
  affectedAccounts: string[];
}

export interface MergeJeScanResult {
  scanned: number;        // JEs examined
  matched: MergeJeRow[];  // JEs that fingerprint as merge JEs touching affected accounts
  matchedAny: MergeJeRow[]; // fingerprinted merge JEs regardless of affected-account filter
  error?: string;
}

function isExcludedClient(clientName: string | null | undefined): boolean {
  const n = (clientName || "").trim().toLowerCase();
  return MERGE_JE_EXCLUDED_CLIENTS.some((x) => n === x || n.includes(x));
}

const AFFECTED_KEYS = new Set(MERGE_JE_AFFECTED_ACCOUNTS.map((a) => normalizeAccountName(a)));
/** Normalized name → matches an affected account (leaf-tolerant). */
function affectedName(name: string): string | null {
  const norm = normalizeAccountName(name || "");
  if (AFFECTED_KEYS.has(norm)) {
    return MERGE_JE_AFFECTED_ACCOUNTS.find((a) => normalizeAccountName(a) === norm) || name;
  }
  const leaf = norm.split(":").pop() || norm;
  const hit = MERGE_JE_AFFECTED_ACCOUNTS.find((a) => {
    const an = normalizeAccountName(a);
    return an === leaf || (an.split(":").pop() || an) === leaf;
  });
  return hit || null;
}

function fingerprintHit(text: string): boolean {
  const t = (text || "").toLowerCase();
  return MERGE_JE_FINGERPRINTS.some((f) => t.includes(f));
}

/**
 * Scan one client's QBO for merge JEs. Read-only. Paginates JournalEntry from
 * `sinceDate` (the merges dated JEs at the activity month-end, which can be any
 * month in the cleanup range — default a wide window). Filters client-side by
 * memo fingerprint (PrivateNote or line Description) and, for `matched`, by the
 * affected-account list.
 */
export async function scanClientForMergeJEs(
  realmId: string,
  accessToken: string,
  opts: { sinceDate?: string } = {}
): Promise<MergeJeScanResult> {
  const since = opts.sinceDate || "2022-01-01";
  const matched: MergeJeRow[] = [];
  const matchedAny: MergeJeRow[] = [];
  let scanned = 0;

  try {
    let start = 1;
    const page = 200;
    // Cap total pages so a huge file can't run away (10 pages × 200 = 2000 JEs).
    for (let p = 0; p < 10; p++) {
      const q = encodeURIComponent(
        `SELECT * FROM JournalEntry WHERE TxnDate >= '${since}' STARTPOSITION ${start} MAXRESULTS ${page}`
      );
      const data = await qboRequest<{ QueryResponse: { JournalEntry?: any[] } }>(
        realmId,
        accessToken,
        `/query?query=${q}`
      );
      const jes = data.QueryResponse.JournalEntry || [];
      if (jes.length === 0) break;
      scanned += jes.length;

      for (const je of jes) {
        const note = je.PrivateNote || "";
        const lineDescs = (je.Line || []).map((l: any) => l.Description || "").join(" ");
        if (!fingerprintHit(note) && !fingerprintHit(lineDescs)) continue;

        const lines: MergeJeLine[] = (je.Line || [])
          .filter((l: any) => l.DetailType === "JournalEntryLineDetail")
          .map((l: any) => {
            const d = l.JournalEntryLineDetail || {};
            return {
              accountId: d.AccountRef?.value || null,
              accountName: d.AccountRef?.name || "",
              posting: (d.PostingType as "Debit" | "Credit") || "Debit",
              amount: Number(l.Amount) || 0,
            };
          });

        const affectedAccounts = [
          ...new Set(lines.map((l) => affectedName(l.accountName)).filter(Boolean) as string[]),
        ];
        const total = lines
          .filter((l) => l.posting === "Debit")
          .reduce((s, l) => s + l.amount, 0);

        const row: MergeJeRow = {
          jeId: je.Id,
          txnDate: je.TxnDate,
          privateNote: note,
          totalAmount: total,
          lines,
          affectedAccounts,
        };
        matchedAny.push(row);
        if (affectedAccounts.length > 0) matched.push(row);
      }

      if (jes.length < page) break;
      start += page;
    }
  } catch (e: any) {
    return { scanned, matched, matchedAny, error: String(e?.message || e).slice(0, 300) };
  }

  return { scanned, matched, matchedAny };
}

export { isExcludedClient };
