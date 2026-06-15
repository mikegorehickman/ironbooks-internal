/**
 * Ironbooks Cleanup Report — PDF document.
 *
 * Built with @react-pdf/renderer (serverless-friendly; no Chromium). Mirrors
 * the brand palette we use everywhere else (teal/navy + slate accents).
 *
 * Rendered by /api/reports/cleanup/[client_link_id] and streamed back as a
 * downloadable PDF the bookkeeper attaches to the client email manually.
 *
 * Sections:
 *   1. Cover           — logo, client name, period, bookkeeper, date
 *   2. Executive summary — 4 stat tiles
 *   3. COA changes      — table of renames / merges / creates / inactivates
 *   4. Categorization   — top categories by spend, top vendors
 *   5. Stripe AR recon  — deposits matched, revenue/fees split (if applicable)
 *   6. What's next      — short standardized closing
 */

import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
  Font,
} from "@react-pdf/renderer";

// ─────────── Brand palette ───────────
const C = {
  teal: "#2D7A75",
  tealDark: "#1F5D58",
  tealLight: "#F4F9F8",
  navy: "#0F1F2E",
  slate: "#475569",
  inkLight: "#94A3B8",
  border: "#CBD5E1",
  borderSoft: "#E5E7EB",
  white: "#FFFFFF",
  green: "#059669",
  amber: "#B45309",
  purple: "#7C3AED",
};

// react-pdf supports Helvetica by default; no font import needed for v1
Font.registerHyphenationCallback((word) => [word]); // disable hyphenation in tables

const fmtMoney = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmtCount = (n: number) => n.toLocaleString("en-US");

// ─────────── Types ───────────

export interface CoaChangeRow {
  action: "rename" | "merge" | "create" | "delete" | "flag";
  current_name: string | null;
  new_name: string | null;
  transaction_count: number;
  reasoning: string | null;
}

export interface CategorySummaryRow {
  account_name: string;
  total_amount: number;
  transaction_count: number;
}

export interface VendorSummaryRow {
  vendor_name: string;
  total_amount: number;
  transaction_count: number;
  primary_category: string;
}

export interface StripeReconSummary {
  deposits_count: number;
  total_deposit_amount: number;
  total_revenue_allocated: number;
  total_fees: number;
  total_tax_on_fees: number;
  unique_customers: number;
}

export interface CleanupReportData {
  client_name: string;
  jurisdiction: "US" | "CA";
  period_start: string;
  period_end: string;
  bookkeeper_name: string;
  generated_at: string;
  /** absolute https URL to the logo (Vercel-hosted /logo.png) */
  logo_url: string;

  // COA section
  coa_actions: CoaChangeRow[];
  coa_summary: {
    renamed: number;
    merged: number;
    created: number;
    inactivated: number;
    flagged: number;
  };

  // Categorization section
  reclass_total_count: number;
  reclass_total_volume: number;
  top_categories: CategorySummaryRow[];
  top_vendors: VendorSummaryRow[];

  // Bank rules — count of permanent auto-categorization rules created
  // for this client during the cleanup. These prevent the same
  // miscategorizations from recurring on future imports.
  bank_rules_count: number;
  /** rules that are pushed to QBO + active in the daily-recon engine */
  bank_rules_active: number;

  // Stripe section (null if not applicable)
  stripe: StripeReconSummary | null;
}

// ─────────── Styles ───────────

const styles = StyleSheet.create({
  page: {
    flexDirection: "column",
    backgroundColor: C.white,
    padding: 0,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: C.navy,
  },
  // Cover
  coverPage: {
    flexDirection: "column",
    backgroundColor: C.white,
    padding: 0,
    fontFamily: "Helvetica",
  },
  coverHeader: {
    backgroundColor: C.navy,
    padding: 40,
    flexDirection: "row",
    alignItems: "center",
  },
  coverLogo: {
    width: 56,
    height: 56,
    marginRight: 16,
  },
  coverBrand: {
    color: C.white,
    fontSize: 28,
    fontWeight: 700,
  },
  coverTagline: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    letterSpacing: 1.5,
    marginTop: 4,
  },
  coverBody: {
    padding: 60,
    flexGrow: 1,
    justifyContent: "center",
  },
  coverTitle: {
    fontSize: 32,
    fontWeight: 700,
    color: C.navy,
    marginBottom: 12,
    letterSpacing: -0.5,
  },
  coverClient: {
    fontSize: 22,
    color: C.teal,
    marginBottom: 40,
  },
  coverMeta: {
    fontSize: 11,
    color: C.slate,
    lineHeight: 1.8,
  },
  coverMetaLabel: {
    color: C.inkLight,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 14,
  },
  coverMetaValue: {
    color: C.navy,
    fontSize: 13,
    fontWeight: 600,
  },
  coverFooterBar: {
    height: 6,
    backgroundColor: C.teal,
  },

  // Body pages
  bodyPage: {
    padding: 40,
    flexDirection: "column",
    flexGrow: 1,
  },
  pageHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: C.teal,
    paddingBottom: 8,
    marginBottom: 18,
  },
  pageHeaderTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: C.navy,
  },
  pageHeaderClient: {
    fontSize: 9,
    color: C.inkLight,
  },

  // Stat tiles
  statRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 24,
  },
  statTile: {
    flex: 1,
    backgroundColor: C.tealLight,
    borderColor: C.teal,
    borderWidth: 0.5,
    borderRadius: 6,
    padding: 12,
  },
  statLabel: {
    fontSize: 8,
    color: C.teal,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    fontWeight: 600,
    marginBottom: 6,
  },
  statValue: {
    fontSize: 20,
    fontWeight: 700,
    color: C.navy,
  },
  statSub: {
    fontSize: 8,
    color: C.slate,
    marginTop: 2,
  },

  // Section headers
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: C.navy,
    marginTop: 16,
    marginBottom: 8,
  },
  sectionSubtitle: {
    fontSize: 9,
    color: C.slate,
    marginBottom: 10,
    lineHeight: 1.4,
  },

  // Tables
  table: {
    borderWidth: 0.5,
    borderColor: C.border,
    borderRadius: 4,
    marginBottom: 12,
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: C.teal,
  },
  tableHeaderCell: {
    color: C.white,
    fontSize: 8,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    padding: 7,
  },
  tableRow: {
    flexDirection: "row",
    borderTopWidth: 0.5,
    borderTopColor: C.borderSoft,
    backgroundColor: C.white,
  },
  tableRowAlt: {
    flexDirection: "row",
    borderTopWidth: 0.5,
    borderTopColor: C.borderSoft,
    backgroundColor: C.tealLight,
  },
  tableCell: {
    fontSize: 9,
    padding: 7,
    color: C.navy,
  },
  tableCellSlate: {
    fontSize: 9,
    padding: 7,
    color: C.slate,
  },
  tableCellRight: {
    fontSize: 9,
    padding: 7,
    color: C.navy,
    textAlign: "right",
  },
  actionBadge: {
    fontSize: 7,
    fontWeight: 700,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 3,
    color: C.white,
  },

  // Footer
  footer: {
    position: "absolute",
    bottom: 25,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: C.inkLight,
    borderTopWidth: 0.5,
    borderTopColor: C.borderSoft,
    paddingTop: 8,
  },

  // What's next
  closingBox: {
    backgroundColor: C.tealLight,
    borderColor: C.teal,
    borderWidth: 0.5,
    borderRadius: 6,
    padding: 16,
    marginTop: 12,
  },
  closingHeader: {
    fontSize: 11,
    fontWeight: 700,
    color: C.teal,
    marginBottom: 8,
  },
  closingItem: {
    fontSize: 9,
    color: C.slate,
    lineHeight: 1.5,
    marginBottom: 5,
  },

  empty: {
    fontSize: 9,
    color: C.inkLight,
    fontStyle: "italic",
    padding: 12,
  },
});

const actionColors: Record<string, string> = {
  rename: C.teal,
  merge: C.purple,
  create: C.green,
  delete: C.amber,
  inactivate: C.amber,
  flag: C.slate,
};

// ─────────── Components ───────────

function Footer({ clientName, page, total }: { clientName: string; page: number; total: number }) {
  return (
    <View style={styles.footer} fixed>
      <Text>Ironbooks · Cleanup Report for {clientName}</Text>
      <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </View>
  );
}

function PageHeader({ title, clientName }: { title: string; clientName: string }) {
  return (
    <View style={styles.pageHeader}>
      <Text style={styles.pageHeaderTitle}>{title}</Text>
      <Text style={styles.pageHeaderClient}>{clientName}</Text>
    </View>
  );
}

// ─────────── The PDF document ───────────

export function CleanupReportPDF({ data }: { data: CleanupReportData }) {
  const periodLabel = `${data.period_start} → ${data.period_end}`;
  const hasStripe = data.stripe !== null;
  const hasCoaChanges = data.coa_actions.length > 0;
  const hasCategories = data.top_categories.length > 0;

  return (
    <Document
      title={`Ironbooks Cleanup Report — ${data.client_name}`}
      author="Ironbooks"
      subject="Bookkeeping Cleanup Summary"
    >
      {/* ─── PAGE 1: COVER ─── */}
      <Page size="LETTER" style={styles.coverPage}>
        <View style={styles.coverHeader}>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image style={styles.coverLogo} src={data.logo_url} />
          <View>
            <Text style={styles.coverBrand}>Ironbooks</Text>
            <Text style={styles.coverTagline}>BOOKKEEPING · CLEANUP</Text>
          </View>
        </View>

        <View style={styles.coverBody}>
          <Text style={styles.coverTitle}>Cleanup Summary</Text>
          <Text style={styles.coverClient}>{data.client_name}</Text>

          <Text style={styles.coverMetaLabel}>Period covered</Text>
          <Text style={styles.coverMetaValue}>{periodLabel}</Text>

          <Text style={styles.coverMetaLabel}>Prepared by</Text>
          <Text style={styles.coverMetaValue}>
            {data.bookkeeper_name} · Ironbooks
          </Text>

          <Text style={styles.coverMetaLabel}>Generated</Text>
          <Text style={styles.coverMetaValue}>{data.generated_at}</Text>

          <Text style={[styles.coverMeta, { marginTop: 40, color: C.slate, lineHeight: 1.5 }]}>
            This report summarizes the changes we made to your Chart of Accounts and how we
            categorized your transactions during the period above. Every change is also
            visible in your QuickBooks Online account.
          </Text>
        </View>

        <View style={styles.coverFooterBar} />
        <Footer clientName={data.client_name} page={1} total={1} />
      </Page>

      {/* ─── PAGE 2: EXECUTIVE SUMMARY + COA CHANGES ─── */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.bodyPage}>
          <PageHeader title="Executive Summary" clientName={data.client_name} />

          <View style={styles.statRow}>
            <View style={styles.statTile}>
              <Text style={styles.statLabel}>Accounts cleaned</Text>
              <Text style={styles.statValue}>
                {fmtCount(
                  data.coa_summary.renamed +
                    data.coa_summary.merged +
                    data.coa_summary.created +
                    data.coa_summary.inactivated
                )}
              </Text>
              <Text style={styles.statSub}>{`${data.coa_summary.renamed} renamed · ${data.coa_summary.merged} merged`}</Text>
            </View>
            <View style={styles.statTile}>
              <Text style={styles.statLabel}>Transactions categorized</Text>
              <Text style={styles.statValue}>{fmtCount(data.reclass_total_count)}</Text>
              <Text style={styles.statSub}>{fmtMoney(data.reclass_total_volume)} total volume</Text>
            </View>
            <View style={styles.statTile}>
              <Text style={styles.statLabel}>Bank rules created</Text>
              <Text style={styles.statValue}>{fmtCount(data.bank_rules_count)}</Text>
              <Text style={styles.statSub}>
                {data.bank_rules_active > 0
                  ? `${data.bank_rules_active} active for future imports`
                  : "auto-categorize future imports"}
              </Text>
            </View>
            {hasStripe ? (
              <View style={styles.statTile}>
                <Text style={styles.statLabel}>Stripe deposits matched</Text>
                <Text style={styles.statValue}>{fmtCount(data.stripe!.deposits_count)}</Text>
                <Text style={styles.statSub}>{fmtMoney(data.stripe!.total_deposit_amount)} reconciled</Text>
              </View>
            ) : (
              <View style={styles.statTile}>
                <Text style={styles.statLabel}>Top category by spend</Text>
                <Text style={[styles.statValue, { fontSize: 14 }]} wrap={false}>
                  {data.top_categories[0]?.account_name || "—"}
                </Text>
                <Text style={styles.statSub}>
                  {data.top_categories[0]
                    ? fmtMoney(data.top_categories[0].total_amount)
                    : "no data"}
                </Text>
              </View>
            )}
          </View>

          <Text style={styles.sectionTitle}>Chart of Accounts changes</Text>
          <Text style={styles.sectionSubtitle}>
            Renames consolidate inconsistent naming into your standard chart. Merges combine
            duplicate accounts. Inactivations remove accounts that were no longer in use.
          </Text>

          {hasCoaChanges ? (
            <View style={styles.table}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.tableHeaderCell, { width: 60 }]}>Action</Text>
                <Text style={[styles.tableHeaderCell, { flex: 1.4 }]}>Original name</Text>
                <Text style={[styles.tableHeaderCell, { flex: 1.4 }]}>Updated to</Text>
                <Text style={[styles.tableHeaderCell, { width: 56, textAlign: "right" }]}>Txns</Text>
              </View>
              {data.coa_actions.slice(0, 50).map((a, i) => (
                <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                  <View style={{ width: 60, padding: 7 }}>
                    <Text
                      style={[
                        styles.actionBadge,
                        { backgroundColor: actionColors[a.action] || C.slate, alignSelf: "flex-start" },
                      ]}
                    >
                      {a.action.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={[styles.tableCell, { flex: 1.4 }]}>{a.current_name || "—"}</Text>
                  <Text style={[styles.tableCell, { flex: 1.4 }]}>{a.new_name || "—"}</Text>
                  <Text style={[styles.tableCellRight, { width: 56 }]}>
                    {a.transaction_count > 0 ? fmtCount(a.transaction_count) : "—"}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.empty}>No COA changes in this period.</Text>
          )}

          {data.coa_actions.length > 50 && (
            <Text style={[styles.sectionSubtitle, { fontStyle: "italic" }]}>
              Showing first 50 of {data.coa_actions.length} changes — full audit trail available in
              your QuickBooks account.
            </Text>
          )}
        </View>
        <Footer clientName={data.client_name} page={2} total={2} />
      </Page>

      {/* ─── PAGE 3: CATEGORIZATION ─── */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.bodyPage}>
          <PageHeader title="Transaction Categorization" clientName={data.client_name} />

          <Text style={styles.sectionTitle}>Top categories by spend</Text>
          <Text style={styles.sectionSubtitle}>
            Where your money went during this period, ranked by total amount across all matching
            transactions.
          </Text>

          {hasCategories ? (
            <View style={styles.table}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Category</Text>
                <Text style={[styles.tableHeaderCell, { width: 60, textAlign: "right" }]}>Txns</Text>
                <Text style={[styles.tableHeaderCell, { width: 100, textAlign: "right" }]}>Total</Text>
              </View>
              {data.top_categories.slice(0, 15).map((c, i) => (
                <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                  <Text style={[styles.tableCell, { flex: 1 }]}>{c.account_name}</Text>
                  <Text style={[styles.tableCellRight, { width: 60 }]}>{fmtCount(c.transaction_count)}</Text>
                  <Text style={[styles.tableCellRight, { width: 100, fontWeight: 700 }]}>
                    {fmtMoney(c.total_amount)}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.empty}>No transactions categorized in this period.</Text>
          )}

          {data.top_vendors.length > 0 && (
            <>
              <Text style={[styles.sectionTitle, { marginTop: 18 }]}>Top vendors</Text>
              <Text style={styles.sectionSubtitle}>
                Vendors you spent the most with during this period, with the category we mapped
                their transactions to.
              </Text>
              <View style={styles.table}>
                <View style={styles.tableHeaderRow}>
                  <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Vendor</Text>
                  <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Mapped to</Text>
                  <Text style={[styles.tableHeaderCell, { width: 50, textAlign: "right" }]}>Txns</Text>
                  <Text style={[styles.tableHeaderCell, { width: 80, textAlign: "right" }]}>Total</Text>
                </View>
                {data.top_vendors.slice(0, 12).map((v, i) => (
                  <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                    <Text style={[styles.tableCell, { flex: 1 }]}>{v.vendor_name}</Text>
                    <Text style={[styles.tableCellSlate, { flex: 1 }]}>{v.primary_category}</Text>
                    <Text style={[styles.tableCellRight, { width: 50 }]}>{fmtCount(v.transaction_count)}</Text>
                    <Text style={[styles.tableCellRight, { width: 80, fontWeight: 700 }]}>
                      {fmtMoney(v.total_amount)}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </View>
        <Footer clientName={data.client_name} page={3} total={3} />
      </Page>

      {/* ─── PAGE 4 (optional): STRIPE RECON ─── */}
      {hasStripe && (
        <Page size="LETTER" style={styles.page}>
          <View style={styles.bodyPage}>
            <PageHeader title="Stripe AR Reconciliation" clientName={data.client_name} />

            <Text style={styles.sectionSubtitle}>
              Stripe deposits matched to your customer invoices, with the processing fee
              calculated from the exact discrepancy between gross charges and the deposited
              amount.
            </Text>

            <View style={styles.statRow}>
              <View style={styles.statTile}>
                <Text style={styles.statLabel}>Deposits matched</Text>
                <Text style={styles.statValue}>{fmtCount(data.stripe!.deposits_count)}</Text>
                <Text style={styles.statSub}>{fmtMoney(data.stripe!.total_deposit_amount)} total</Text>
              </View>
              <View style={styles.statTile}>
                <Text style={styles.statLabel}>Revenue allocated</Text>
                <Text style={styles.statValue}>{fmtMoney(data.stripe!.total_revenue_allocated)}</Text>
                <Text style={styles.statSub}>{data.stripe!.unique_customers} unique customers</Text>
              </View>
              <View style={styles.statTile}>
                <Text style={styles.statLabel}>Stripe fees</Text>
                <Text style={styles.statValue}>{fmtMoney(data.stripe!.total_fees)}</Text>
                <Text style={styles.statSub}>
                  {data.jurisdiction === "CA" && data.stripe!.total_tax_on_fees > 0
                    ? `+ ${fmtMoney(data.stripe!.total_tax_on_fees)} tax (ITC)`
                    : "expensed to Bank Charges"}
                </Text>
              </View>
            </View>

            <Text style={styles.sectionTitle}>What this means for your books</Text>
            <Text style={styles.sectionSubtitle}>
              Each Stripe deposit in your bank account was decomposed into the customer payments
              that produced it (income), the sales tax collected from those customers (if
              applicable in your province), and the Stripe processing fee deducted by Stripe
              before the deposit landed. This gives you accurate revenue numbers and a clean fee
              expense line — instead of one lump-sum deposit with no detail.
            </Text>
          </View>
          <Footer clientName={data.client_name} page={4} total={4} />
        </Page>
      )}

      {/* ─── FINAL PAGE: WHAT'S NEXT ─── */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.bodyPage}>
          <PageHeader title="Going forward" clientName={data.client_name} />

          <Text style={styles.sectionSubtitle}>
            Your books are now in a clean state for the period covered. To keep them that way
            with the least friction on your end, here's what we recommend:
          </Text>

          <View style={styles.closingBox}>
            <Text style={styles.closingHeader}>Keep us looped in on these</Text>
            <Text style={styles.closingItem}>
              · New customer Venmo / Zelle / e-transfers — a quick "what was this for?" reply
              keeps your AR clean.
            </Text>
            <Text style={styles.closingItem}>
              · Vendor changes — if you start using a new supplier or switch banks, let us know
              so we don't have to guess at first sight.
            </Text>
            <Text style={styles.closingItem}>
              · Owner draws or contributions — flag those so we don't accidentally categorize
              them as expenses or income.
            </Text>
          </View>

          <View style={[styles.closingBox, { marginTop: 16, backgroundColor: C.white, borderColor: C.borderSoft }]}>
            <Text style={[styles.closingHeader, { color: C.navy }]}>What we'll do automatically</Text>
            <Text style={styles.closingItem}>
              · Every transaction matching a rule we've now established will route to the right
              account on its own.
            </Text>
            <Text style={styles.closingItem}>
              · New vendors will be flagged for our review, not auto-guessed.
            </Text>
            <Text style={styles.closingItem}>
              · We'll reconcile and email you summary reports like this one on a recurring
              cadence.
            </Text>
          </View>

          <Text
            style={{
              marginTop: 28,
              fontSize: 9,
              color: C.slate,
              lineHeight: 1.5,
            }}
          >
            Questions about anything in this report? Just reply to the email we sent — your
            bookkeeper will get back to you within one business day.
          </Text>

          <Text
            style={{
              marginTop: 24,
              fontSize: 11,
              color: C.navy,
              fontWeight: 700,
            }}
          >
            Kindly,
          </Text>
          <Text style={{ fontSize: 11, color: C.navy }}>{data.bookkeeper_name}</Text>
          <Text style={{ fontSize: 9, color: C.inkLight, marginTop: 2 }}>Ironbooks</Text>
        </View>
        <Footer clientName={data.client_name} page={5} total={5} />
      </Page>
    </Document>
  );
}
