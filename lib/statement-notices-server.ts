/**
 * Notice to Reader — server half (AI generation + fetch helpers).
 * The pure, client-safe core lives in lib/statement-notices.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  buildNoticeDraftPrompt,
  noticePeriodLabel,
  toRunPeriod,
  DEFAULT_BOILERPLATE,
  type ReceiptLike,
} from "./statement-notices";

// Same model the dashboard narrative uses — one house voice for client prose.
const MODEL = "claude-opus-4-7";

/**
 * Gather this month's context and draft the AI section. Called on demand from
 * the compose UI ([Generate]); the manager edits before sending — nothing here
 * is ever auto-sent. Returns plain text.
 */
export async function generateNoticeDraft(
  service: any,
  clientLinkId: string,
  periodYear: number,
  periodMonth: number
): Promise<string> {
  const period = toRunPeriod(periodYear, periodMonth);

  const { data: client } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", clientLinkId)
    .single();

  // The month's run: red flags, concerns, outstanding draft questions.
  const { data: run } = await (service as any)
    .from("monthly_rec_runs")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .eq("period", period)
    .maybeSingle();

  const redFlags: string[] = [];
  try {
    const v = (run as any)?.verification;
    for (const f of v?.red_flags || v?.redFlags || []) {
      const title = typeof f === "string" ? f : f?.title || f?.label || f?.message;
      if (title) redFlags.push(String(title));
    }
  } catch { /* verification shape varies; absent is fine */ }

  const openQuestions: string[] = [];
  try {
    for (const d of ((run as any)?.draft_sends || []) as any[]) {
      if (d?.question) openQuestions.push(String(d.question));
    }
  } catch { /* optional */ }

  // Unanswered client messages (not yet dismissed by the team).
  let unanswered: string[] = [];
  try {
    const { data: msgs } = await service
      .from("client_communications")
      .select("subject, body")
      .eq("client_link_id", clientLinkId)
      .eq("direction", "from_client")
      .is("dismissed_at", null)
      .order("created_at", { ascending: false })
      .limit(8);
    unanswered = (msgs || []).map((m: any) => m.subject || (m.body || "").slice(0, 200)).filter(Boolean);
  } catch { /* table always exists, but stay fail-soft */ }

  const prompt = buildNoticeDraftPrompt({
    clientName: (client as any)?.client_name || "the company",
    periodLabel: noticePeriodLabel(periodYear, periodMonth),
    redFlags,
    concerns: (run as any)?.concerns ?? null,
    openQuestions,
    unansweredClientMessages: unanswered,
  });

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("The draft came back empty — try again.");
  return text;
}


// ── Fetch helpers (fail-soft: migration 156 is applied by hand) ────────────

export function noticeTablesMissing(err: any): boolean {
  const msg = String(err?.message || err || "");
  return err?.code === "42P01" || /relation .*(statement_notices|statement_notice_receipts).* does not exist/i.test(msg);
}

export interface StatementNotice {
  id: string;
  client_link_id: string;
  period_year: number;
  period_month: number;
  boilerplate_body: string;
  ai_body: string | null;
  custom_body: string | null;
  sent_by: string;
  sent_by_name: string | null;
  sent_by_email: string | null;
  sent_at: string;
  resend_count: number;
  first_reply_at: string | null;
}

export async function fetchLatestNotice(service: any, clientLinkId: string): Promise<StatementNotice | null> {
  try {
    const { data, error } = await (service as any)
      .from("statement_notices")
      .select("*")
      .eq("client_link_id", clientLinkId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as StatementNotice) ?? null;
  } catch (err) {
    if (noticeTablesMissing(err)) return null;
    throw err;
  }
}

export async function fetchNoticeForPeriod(
  service: any,
  clientLinkId: string,
  periodYear: number,
  periodMonth: number
): Promise<StatementNotice | null> {
  try {
    const { data, error } = await (service as any)
      .from("statement_notices")
      .select("*")
      .eq("client_link_id", clientLinkId)
      .eq("period_year", periodYear)
      .eq("period_month", periodMonth)
      .maybeSingle();
    if (error) throw error;
    return (data as StatementNotice) ?? null;
  } catch (err) {
    if (noticeTablesMissing(err)) return null;
    throw err;
  }
}

export async function fetchReceipt(
  service: any,
  noticeId: string,
  userId: string
): Promise<ReceiptLike | null> {
  try {
    const { data, error } = await (service as any)
      .from("statement_notice_receipts")
      .select("first_viewed_at, acknowledged_at")
      .eq("notice_id", noticeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data as ReceiptLike) ?? null;
  } catch (err) {
    if (noticeTablesMissing(err)) return null;
    throw err;
  }
}

/**
 * Guarantee a Notice to Reader exists for a period before statements are
 * published — the "no P&L goes out without a notice" rule (Mike 2026-08-04)
 * applied to paths that publish a package WITHOUT the rec-card compose step
 * (the admin portal-package backfill). If a notice is already on file it is
 * left completely alone: the manager's wording wins, and sent_at is NOT bumped
 * (bumping would silently invalidate acknowledgements the client already gave).
 * Otherwise the standard boilerplate is filed under the acting admin.
 *
 * Throws on failure — callers must treat that as "don't publish".
 */
export async function ensureNoticeForPeriod(
  service: any,
  opts: {
    clientLinkId: string;
    clientName: string;
    periodYear: number;
    periodMonth: number;
    actingUserId: string;
    actingUserName?: string | null;
    actingUserEmail?: string | null;
  }
): Promise<{ created: boolean; noticeId: string | null }> {
  const existing = await fetchNoticeForPeriod(
    service,
    opts.clientLinkId,
    opts.periodYear,
    opts.periodMonth
  );
  if (existing) return { created: false, noticeId: existing.id };

  const label = noticePeriodLabel(opts.periodYear, opts.periodMonth);
  const now = new Date().toISOString();
  const { data, error } = await (service as any)
    .from("statement_notices")
    .insert({
      client_link_id: opts.clientLinkId,
      period_year: opts.periodYear,
      period_month: opts.periodMonth,
      boilerplate_body: DEFAULT_BOILERPLATE(opts.clientName, label),
      sent_by: opts.actingUserId,
      sent_by_name: opts.actingUserName || null,
      sent_by_email: opts.actingUserEmail || null,
      sent_at: now,
      resend_count: 0,
      updated_at: now,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { created: true, noticeId: (data as any)?.id ?? null };
}
