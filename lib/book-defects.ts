/**
 * Book-defect ledger — registry + reconciliation (migration 156).
 *
 * The ledger answers one question: "are this client's books right, and if not,
 * why?" It is NOT a scanner. Every defect class already has a scanner; what was
 * missing is a single place they report into, so the answer survives the tab
 * being closed.
 *
 * Two rules make it trustworthy rather than a stale to-do list:
 *
 *   1. RECONCILE, DON'T ACCUMULATE. A fleet scan reports the FULL current set
 *      of affected clients for its type. Anything open that the scan no longer
 *      sees is auto-resolved as 'no_longer_detected'. A findings table that
 *      only grows is a findings table nobody trusts by month two.
 *
 *   2. ABSENCE ISN'T CLEANLINESS. book_defect_scans records when each type was
 *      last swept, so the board can distinguish "checked, clean" from "never
 *      looked". Those are wildly different claims to make about a client's books.
 *
 * Human decisions always win over a scanner: rows in 'accepted' are never
 * reopened by a sweep, and 'remediating' survives a re-scan that still sees the
 * problem (of course it does — someone is mid-fix).
 */

export type DefectStatus = "open" | "remediating" | "resolved" | "accepted";
export type DefectSeverity = "critical" | "high" | "medium" | "low";

export interface DefectType {
  key: string;
  label: string;
  /** What's actually wrong with the books, in a sentence a bookkeeper reads. */
  description: string;
  defaultSeverity: DefectSeverity;
  /** Where the underlying detail lives — the "show me" link. */
  detailHref?: (clientLinkId: string) => string;
  /** Fleet screen for this defect class, if one exists. */
  fleetHref?: string;
  /** True when a scanner persists its own findings and the ledger can be
   *  derived from them (see /api/book-defects/sync). False = the scanner is
   *  ephemeral today and must POST its results explicitly. */
  derivable: boolean;
}

/**
 * The registry. Adding a defect class is a deploy, not a migration — the
 * labels belong next to the logic that produces them.
 *
 * Every entry here traces to a real, measured incident. Keep it that way:
 * speculative defect types make the "clean" number meaningless.
 */
export const DEFECT_TYPES: DefectType[] = [
  {
    key: "revenue_double_count",
    label: "Revenue double-counted",
    description:
      "Bank deposits booked straight to an income account while the matching invoice also posts revenue — income overstated on both legs.",
    defaultSeverity: "critical",
    fleetHref: "/admin/revenue-integrity",
    derivable: true,
  },
  {
    key: "crm_invoice_double_count",
    label: "CRM invoice double-count",
    description:
      "A CRM-created invoice and its deposit both recognize revenue. Fixed by matching the deposit to the invoice's payment, not by voiding.",
    defaultSeverity: "critical",
    fleetHref: "/admin/crm-invoice-revenue",
    derivable: true,
  },
  {
    key: "duplicate_transactions",
    label: "Duplicate transactions",
    description: "The same expense or deposit recorded more than once.",
    defaultSeverity: "high",
    detailHref: (id) => `/admin/duplicates?client=${id}`,
    fleetHref: "/admin/duplicates",
    derivable: true,
  },
  {
    key: "payroll_double_count",
    label: "Payroll double-counted",
    description:
      "Gross paycheque and the net-pay bank deposit both expensed, inflating labour across two accounts.",
    defaultSeverity: "critical",
    fleetHref: "/admin/payroll-double-scan",
    derivable: false,
  },
  {
    key: "coa_merge_je_damage",
    label: "Collapsed GL detail (merge JE)",
    description:
      "A SNAP COA merge posted a lump journal entry instead of a native merge, collapsing transaction-level detail on the account.",
    defaultSeverity: "high",
    fleetHref: "/admin/coa-je-audit",
    derivable: false,
  },
  {
    key: "parent_account_postings",
    label: "Postings to a parent account",
    description:
      "Transactions posted directly to a parent account, which breaks sub-account reporting. Hard rule: never allowed.",
    defaultSeverity: "medium",
    fleetHref: "/coa-audit",
    derivable: false,
  },
  {
    key: "coa_nonconformance",
    label: "Chart of accounts off-master",
    description:
      "The client's chart has drifted from the master COA — wrong types, wrong parents, non-master accounts.",
    defaultSeverity: "medium",
    detailHref: (id) => `/coa-audit?client=${id}`,
    fleetHref: "/admin/coa-conformance",
    derivable: true,
  },
  {
    key: "ucpi_unresolved",
    label: "Unapplied cash payment income",
    description:
      "Customer payments sitting unapplied, so QuickBooks reports them as income with no invoice behind them.",
    defaultSeverity: "high",
    derivable: true,
  },
  {
    key: "undeposited_funds",
    label: "Undeposited Funds not clear",
    description:
      "A stale Undeposited Funds balance — payments recorded but never matched to a bank deposit.",
    defaultSeverity: "high",
    fleetHref: "/admin/uf-eradication",
    derivable: true,
  },
  {
    key: "phantom_ar",
    label: "Phantom A/R",
    description:
      "Accounts receivable that isn't really owed — duplicate invoices, orphaned payments, stale balances.",
    defaultSeverity: "high",
    derivable: true,
  },
];

const BY_KEY = new Map(DEFECT_TYPES.map((d) => [d.key, d]));
export function defectType(key: string): DefectType | null {
  return BY_KEY.get(key) ?? null;
}
export function isKnownDefectType(key: string): boolean {
  return BY_KEY.has(key);
}

/** Statuses that mean "this client's books are currently not trustworthy". */
export const LIVE_STATUSES: DefectStatus[] = ["open", "remediating"];

export const SEVERITY_RANK: Record<DefectSeverity, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

/** One client's defect for a scanner to report. */
export interface DefectReport {
  clientLinkId: string;
  exposureCents?: number | null;
  itemCount?: number | null;
  severity?: DefectSeverity;
  detail?: Record<string, unknown>;
}

export interface ReconcileResult {
  found: number;
  opened: number;
  updated: number;
  autoResolved: number;
}

type AnySupabase = any;

/**
 * Report a scan's results for ONE defect type and reconcile the ledger.
 *
 * `scope` decides what auto-resolve is allowed to touch:
 *   { kind: "fleet" }               → the report is the whole truth; every open
 *                                     row of this type not in it is resolved
 *   { kind: "clients", ids: [...] } → only those clients were examined, so only
 *                                     they may be auto-resolved
 *
 * That distinction matters. A single-client re-scan must never mark the other
 * 76 clients clean just because it didn't look at them — which is exactly the
 * bug a naive "delete then insert" implementation ships with.
 */
export async function reportDefects(
  service: AnySupabase,
  opts: {
    defectType: string;
    reports: DefectReport[];
    scope: { kind: "fleet" } | { kind: "clients"; ids: string[] };
    source: string;
    /** How many clients the scan actually examined — recorded so the board can
     *  say "swept 78 clients, 6 dirty" rather than only showing the hits. */
    clientsScanned?: number;
    ranBy?: string | null;
  }
): Promise<ReconcileResult> {
  const type = defectType(opts.defectType);
  if (!type) throw new Error(`Unknown defect type: ${opts.defectType}`);

  const now = new Date().toISOString();
  const reports = opts.reports.filter((r) => !!r.clientLinkId);
  const reportedIds = new Set(reports.map((r) => r.clientLinkId));

  // Existing rows for this type, so we can tell open-new from still-open and
  // leave human decisions ('accepted') alone.
  const { data: existingRows } = await service
    .from("book_defects")
    .select("id, client_link_id, status")
    .eq("defect_type", opts.defectType);
  const existing = new Map<string, { id: string; status: DefectStatus }>(
    ((existingRows as any[]) || []).map((r) => [r.client_link_id, { id: r.id, status: r.status }])
  );

  let opened = 0;
  let updated = 0;

  for (const r of reports) {
    const prior = existing.get(r.clientLinkId);
    const severity = r.severity || type.defaultSeverity;
    const base = {
      exposure_cents: r.exposureCents ?? null,
      item_count: r.itemCount ?? null,
      detail: r.detail ?? {},
      severity,
      last_seen_at: now,
      updated_at: now,
    };

    if (!prior) {
      await service.from("book_defects").insert({
        client_link_id: r.clientLinkId,
        defect_type: opts.defectType,
        status: "open",
        detected_at: now,
        ...base,
      });
      opened++;
      continue;
    }

    // 'accepted' is a human calling it immaterial — a scanner doesn't overrule
    // that. Refresh the numbers so the record stays accurate, but leave status.
    if (prior.status === "accepted") {
      await service.from("book_defects").update(base).eq("id", prior.id);
      updated++;
      continue;
    }

    // Still detected: keep 'remediating' if someone is mid-fix, otherwise it's
    // open again (a resolved row that reappears genuinely IS open again).
    const nextStatus = prior.status === "remediating" ? "remediating" : "open";
    await service
      .from("book_defects")
      .update({
        ...base,
        status: nextStatus,
        ...(prior.status === "resolved"
          ? { resolved_at: null, resolved_by: null, resolution: null, detected_at: now }
          : {}),
      })
      .eq("id", prior.id);
    updated++;
  }

  // Auto-resolve what this scan looked at and did NOT find.
  const inScope = (clientLinkId: string) =>
    opts.scope.kind === "fleet" || opts.scope.ids.includes(clientLinkId);

  const toResolve = [...existing.entries()]
    .filter(([clientLinkId, row]) =>
      LIVE_STATUSES.includes(row.status) && !reportedIds.has(clientLinkId) && inScope(clientLinkId)
    )
    .map(([, row]) => row.id);

  if (toResolve.length > 0) {
    await service
      .from("book_defects")
      .update({
        status: "resolved",
        resolution: "no_longer_detected",
        resolved_at: now,
        updated_at: now,
      })
      .in("id", toResolve);
  }

  await service.from("book_defect_scans").insert({
    defect_type: opts.defectType,
    client_link_id: opts.scope.kind === "clients" && opts.scope.ids.length === 1 ? opts.scope.ids[0] : null,
    source: opts.source,
    clients_scanned:
      opts.clientsScanned ?? (opts.scope.kind === "clients" ? opts.scope.ids.length : reports.length),
    defects_found: reports.length,
    auto_resolved: toResolve.length,
    ran_by: opts.ranBy ?? null,
  });

  return { found: reports.length, opened, updated, autoResolved: toResolve.length };
}
