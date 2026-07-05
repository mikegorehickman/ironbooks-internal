/**
 * Today-page priority model.
 * ==========================
 *
 * Pure, defensive scoring over data the /today page already fetched — NO
 * queries here. Produces (a) the single "Focus now" hero item and (b) the
 * pulse-bar counts, so the page can lead with what matters instead of a
 * flat widget stack.
 *
 * Honest constraint: only cleanup (client_links.due_date) carries a REAL
 * due date. Flags,
 * reclass requests, and client messages have no due/SLA column, so their
 * urgency is age-based (oldest first) and is always surfaced with a plain
 * "why-now" string — never a fabricated deadline.
 *
 * Hero precedence (first non-empty tier wins; an item never appears twice):
 *   1. BLOCKED        — client paused (downstream work silently disabled)
 *   2. OVERDUE        — real due_date < today (most overdue first)
 *   3. HIGH-RISK      — most anomaly flags on pending review rows
 *   4. CLIENT-WAITING — oldest flag / reclass request / unread message
 *   5. ROUTINE        — most pending review decisions
 *   (else) calm "you're clear" state.
 */

export type HeroTone = "red" | "amber" | "teal";

export interface TodayHero {
  tone: HeroTone;
  client: string;
  whyNow: string;
  ctaHref: string;
  ctaLabel: string;
}

export interface TodayCounts {
  blocked: number;
  overdue: number;
  dueToday: number;
  dueSoon: number; // due within the next 3 days (excludes today)
  needsYou: number;
}

export interface TodayPriorityResult {
  hero: TodayHero | null;
  counts: TodayCounts;
}

interface DatedItem {
  due: string; // YYYY-MM-DD
  name: string;
  clientId: string;
}

interface WaitingItem {
  at: string | null;
  name: string;
  clientId: string;
  kind: "flag" | "reclass" | "comm";
}

export interface TodayPriorityInput {
  eligibleClients: Array<{
    id: string;
    client_name: string;
    daily_recon_paused?: boolean | null;
    daily_recon_paused_reason?: string | null;
  }>;
  pendingFlags: Array<{ client_link_id: string; client_name?: string; submitted_at?: string | null }>;
  pendingReclassRequests: Array<{ client_link_id: string; client_name?: string; requested_at?: string | null }>;
  inboundComms: Array<{ client_link_id: string; client_name?: string; created_at?: string | null }>;
  cleanupDeadlines: Array<{ client_link_id: string; client_name: string; due_date: string | null }>;
  pendingByClient: Map<string, number>;
  anomaliesByClient: Map<string, number>;
  clientNameById: Map<string, string>;
  totalPending: number;
  /** today as YYYY-MM-DD */
  todayStr: string;
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(fromISO + "T00:00:00").getTime();
  const b = new Date(toISO + "T00:00:00").getTime();
  return Math.round((b - a) / 86400000);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function computeTodayPriority(input: TodayPriorityInput): TodayPriorityResult {
  const {
    eligibleClients,
    pendingFlags,
    pendingReclassRequests,
    inboundComms,
    cleanupDeadlines,
    pendingByClient,
    anomaliesByClient,
    clientNameById,
    totalPending,
    todayStr,
  } = input;

  // ── Due-date buckets (only cleanup deadlines have real due dates) ──
  const dated: DatedItem[] = [];
  for (const c of cleanupDeadlines || []) {
    if (c?.due_date) dated.push({ due: c.due_date, name: c.client_name, clientId: c.client_link_id });
  }
  const soonCutoff = addDaysISO(todayStr, 3);
  let overdue = 0;
  let dueToday = 0;
  let dueSoon = 0;
  for (const d of dated) {
    if (d.due < todayStr) overdue++;
    else if (d.due === todayStr) dueToday++;
    else if (d.due <= soonCutoff) dueSoon++;
  }

  const blocked = (eligibleClients || []).filter((c) => c?.daily_recon_paused).length;
  const needsYou =
    (pendingFlags?.length || 0) +
    (pendingReclassRequests?.length || 0) +
    (inboundComms?.length || 0) +
    (totalPending || 0);

  const counts: TodayCounts = { blocked, overdue, dueToday, dueSoon, needsYou };

  // ── Hero precedence ──

  // 1. BLOCKED
  const paused = (eligibleClients || []).find((c) => c?.daily_recon_paused);
  if (paused) {
    return {
      hero: {
        tone: "red",
        client: paused.client_name,
        whyNow: `Daily recon paused${paused.daily_recon_paused_reason ? ` — ${paused.daily_recon_paused_reason}` : ""}`,
        ctaHref: `/clients/${paused.id}`,
        ctaLabel: "Resolve",
      },
      counts,
    };
  }

  // 2. OVERDUE — earliest due = most overdue
  const overdueItems = dated.filter((d) => d.due < todayStr).sort((a, b) => a.due.localeCompare(b.due));
  if (overdueItems.length > 0) {
    const top = overdueItems[0];
    const days = Math.max(1, daysBetween(top.due, todayStr));
    return {
      hero: {
        tone: "red",
        client: top.name,
        whyNow: `Cleanup ${plural(days, "day")} overdue`,
        ctaHref: `/clients/${top.clientId}`,
        ctaLabel: "Continue cleanup",
      },
      counts,
    };
  }

  // 3. HIGH-RISK — most anomalies
  let topAnomClient = "";
  let topAnom = 0;
  for (const [cid, n] of anomaliesByClient || []) {
    if (n > topAnom) {
      topAnom = n;
      topAnomClient = cid;
    }
  }
  if (topAnom > 0) {
    return {
      hero: {
        tone: "amber",
        client: clientNameById.get(topAnomClient) || "A client",
        whyNow: `${plural(topAnom, "high-risk transaction")} to review`,
        ctaHref: `/today/${topAnomClient}`,
        ctaLabel: "Review",
      },
      counts,
    };
  }

  // 4. CLIENT-WAITING — oldest of flags / reclass / messages
  const waiting: WaitingItem[] = [];
  for (const f of pendingFlags || []) waiting.push({ at: f.submitted_at || null, name: f.client_name || "A client", clientId: f.client_link_id, kind: "flag" });
  for (const r of pendingReclassRequests || []) waiting.push({ at: r.requested_at || null, name: r.client_name || "A client", clientId: r.client_link_id, kind: "reclass" });
  for (const m of inboundComms || []) waiting.push({ at: m.created_at || null, name: m.client_name || "A client", clientId: m.client_link_id, kind: "comm" });
  const datedWaiting = waiting.filter((w) => w.at).sort((a, b) => (a.at as string).localeCompare(b.at as string));
  if (datedWaiting.length > 0) {
    const top = datedWaiting[0];
    const days = daysBetween((top.at as string).slice(0, 10), todayStr);
    return {
      hero: {
        tone: "amber",
        client: top.name,
        whyNow: `Client waiting ${days <= 0 ? "since today" : plural(days, "day")}`,
        ctaHref: top.kind === "comm" ? `/clients/${top.clientId}/messages` : `/clients/${top.clientId}`,
        ctaLabel: "Respond",
      },
      counts,
    };
  }

  // 5. ROUTINE — most pending review decisions
  let topPendClient = "";
  let topPend = 0;
  for (const [cid, n] of pendingByClient || []) {
    if (n > topPend) {
      topPend = n;
      topPendClient = cid;
    }
  }
  if (topPend > 0) {
    return {
      hero: {
        tone: "amber",
        client: clientNameById.get(topPendClient) || "A client",
        whyNow: `${plural(topPend, "transaction")} need your decision`,
        ctaHref: `/today/${topPendClient}`,
        ctaLabel: "Review",
      },
      counts,
    };
  }

  // Calm state
  return { hero: null, counts };
}
