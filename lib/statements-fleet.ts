/**
 * Statements home — one fleet view of where every client's statements stand.
 *
 * Statement activity was scattered: the per-client Overview card, the senior
 * approvals widget, the one-off backfill tool, and the monthly rec cards. None
 * answered "across the fleet, who's had statements sent, who's overdue, who
 * bounced?" This assembles that from the durable send record — client_email_log
 * rows with email_type 'bs_statements' (delivery status kept live by the Resend
 * webhook) — joined to the active-client roster so clients with NOTHING sent
 * surface as gaps rather than silently missing.
 */

export interface StatementFleetRow {
  clientId: string;
  clientName: string;
  isProduction: boolean;
  assignedBookkeeperId: string | null;
  lastSubject: string | null;
  lastSentAt: string | null;
  lastStatus: string | null; // sent | delivered | opened | bounced | failed
  everSent: boolean;
}

export interface StatementsFleet {
  rows: StatementFleetRow[];
  summary: {
    total: number;
    sent: number; // clients with ≥1 statement ever
    neverSent: number; // active production clients with none
    bounced: number; // clients whose latest statement bounced/failed
  };
}

export async function getStatementsFleet(service: any): Promise<StatementsFleet> {
  // Active client roster.
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, is_active, daily_recon_enabled, cleanup_completed_at, assigned_bookkeeper_id")
    .eq("is_active", true)
    .order("client_name");

  // All statement sends, newest first — we keep the latest per client.
  const { data: logs } = await (service as any)
    .from("client_email_log")
    .select("client_link_id, subject, status, created_at")
    .eq("email_type", "bs_statements")
    .order("created_at", { ascending: false })
    .limit(5000);

  const latestByClient = new Map<string, { subject: string; status: string; created_at: string }>();
  for (const l of ((logs as any[]) || [])) {
    if (!latestByClient.has(l.client_link_id)) {
      latestByClient.set(l.client_link_id, {
        subject: l.subject,
        status: l.status,
        created_at: l.created_at,
      });
    }
  }

  const rows: StatementFleetRow[] = ((clients as any[]) || []).map((c) => {
    const latest = latestByClient.get(c.id);
    const isProduction = !!c.daily_recon_enabled && !!c.cleanup_completed_at;
    return {
      clientId: c.id,
      clientName: c.client_name || "(unnamed)",
      isProduction,
      assignedBookkeeperId: c.assigned_bookkeeper_id || null,
      lastSubject: latest?.subject || null,
      lastSentAt: latest?.created_at || null,
      lastStatus: latest?.status || null,
      everSent: !!latest,
    };
  });

  const isBounced = (s: string | null) => s === "bounced" || s === "failed";
  const summary = {
    total: rows.length,
    sent: rows.filter((r) => r.everSent).length,
    // A "gap" that matters: live/production clients who've never had statements.
    neverSent: rows.filter((r) => r.isProduction && !r.everSent).length,
    bounced: rows.filter((r) => isBounced(r.lastStatus)).length,
  };

  // Sort: production-never-sent (gaps) first, then bounced, then by most recent.
  rows.sort((a, b) => {
    const aGap = a.isProduction && !a.everSent ? 0 : 1;
    const bGap = b.isProduction && !b.everSent ? 0 : 1;
    if (aGap !== bGap) return aGap - bGap;
    const aB = isBounced(a.lastStatus) ? 0 : 1;
    const bB = isBounced(b.lastStatus) ? 0 : 1;
    if (aB !== bB) return aB - bB;
    return (b.lastSentAt || "").localeCompare(a.lastSentAt || "");
  });

  return { rows, summary };
}
