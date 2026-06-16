/**
 * Grain integration — pull a client's coaching/bookkeeping call recordings,
 * AI summaries, and action items, scoped to calls HOSTED BY IRONBOOKS.
 *
 * Auth: a Grain API token (Personal Access Token from Grain → Settings → API,
 * or a workspace token). Set GRAIN_API_TOKEN in Vercel. Without it, the
 * profile section shows a "connect Grain" empty state instead of erroring.
 *
 *   GRAIN_API_TOKEN   — Bearer token for the Grain API
 *   GRAIN_API_BASE    — defaults to https://api.grain.com/_/public-api
 *
 * NOTE ON VERIFICATION: the data SHAPE here (participants[].email/scope,
 * summary, action_items[].assignee) was confirmed against Grain's intelligence
 * API. Field names are read defensively (several fallbacks) because the
 * token-auth REST responses can differ slightly from the connector. Once a
 * real token is in, confirm the first response and tighten if needed — the
 * mapping is isolated to `normalizeRecording` / `normalizeActionItems`.
 */

const BASE = process.env.GRAIN_API_BASE || "https://api.grain.com/_/public-api";
const IRONBOOKS_DOMAIN = "ironbooks.com";

export function grainConfigured(): boolean {
  return !!process.env.GRAIN_API_TOKEN;
}

async function grainGet<T>(path: string): Promise<T> {
  const token = process.env.GRAIN_API_TOKEN;
  if (!token) throw new Error("GRAIN_API_TOKEN not configured");
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Grain ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export interface GrainParticipant {
  name: string | null;
  email: string | null;
  scope: string | null; // internal | external | unknown
}

export interface GrainActionItem {
  text: string;
  status: string | null; // pending | completed
  dueDate: string | null;
  assigneeName: string | null;
  transcriptUrl: string | null;
}

export interface GrainRecording {
  id: string;
  title: string;
  url: string | null;
  startDatetime: string | null;
  durationLabel: string | null;
  summary: string | null;
  participants: GrainParticipant[];
  /** The @ironbooks.com internal participant who hosted/ran the call. */
  ironbooksHost: GrainParticipant | null;
  actionItems: GrainActionItem[];
}

function emailDomain(email: string | null | undefined): string {
  return (email || "").split("@")[1]?.toLowerCase() || "";
}

function normalizeParticipants(raw: any): GrainParticipant[] {
  const list: any[] = raw?.participants || raw?.attendees || [];
  return list.map((p) => ({
    name: p.name ?? null,
    email: (p.email ?? null) ? String(p.email).toLowerCase() : null,
    scope: p.scope ?? null,
  }));
}

function normalizeActionItems(raw: any): GrainActionItem[] {
  const list: any[] = raw?.action_items || raw?.actionItems || [];
  return list.map((a) => ({
    text: a.text ?? a.description ?? "",
    status: a.status ?? null,
    dueDate: a.due_date ?? a.dueDate ?? null,
    assigneeName: a.assignee?.name ?? a.assignee_name ?? null,
    transcriptUrl: a.transcript_url ?? a.transcriptUrl ?? null,
  })).filter((a) => a.text);
}

function normalizeRecording(raw: any): GrainRecording {
  const participants = normalizeParticipants(raw);
  const ironbooksHost =
    participants.find((p) => emailDomain(p.email) === IRONBOOKS_DOMAIN) || null;
  return {
    id: raw.id,
    title: raw.title ?? "Untitled call",
    url: raw.url ?? raw.share_url ?? (raw.id ? `https://grain.com/share/recording/${raw.id}` : null),
    startDatetime: raw.start_datetime ?? raw.startDatetime ?? null,
    durationLabel: raw.duration ?? null,
    summary: raw.summary ?? raw.intelligence_summary ?? null,
    participants,
    ironbooksHost,
    actionItems: normalizeActionItems(raw),
  };
}

/** True if any participant's email is on the ironbooks.com domain. */
function hasIronbooksHost(rec: GrainRecording): boolean {
  return rec.participants.some((p) => emailDomain(p.email) === IRONBOOKS_DOMAIN);
}

/** Does this recording involve the given client (by email or name match)? */
function matchesClient(
  rec: GrainRecording,
  matchEmails: string[],
  matchNames: string[]
): boolean {
  const emails = matchEmails.map((e) => e.toLowerCase()).filter(Boolean);
  const names = matchNames.map((n) => n.toLowerCase()).filter(Boolean);
  return rec.participants.some((p) => {
    const pe = (p.email || "").toLowerCase();
    const pn = (p.name || "").toLowerCase();
    if (pe && emails.includes(pe)) return true;
    // Name match: a configured name token appears in the participant name
    // (and the participant isn't the ironbooks host).
    if (pn && emailDomain(p.email) !== IRONBOOKS_DOMAIN) {
      return names.some((n) => n.length > 2 && (pn.includes(n) || n.includes(pn)));
    }
    return false;
  });
}

/**
 * List a client's Ironbooks-hosted recordings with summaries + action items.
 * Pages through recent recordings (capped), filters to those that BOTH have
 * an @ironbooks.com host AND involve the client, then fetches each match's
 * detail (summary + action items).
 */
export async function listClientGrainRecordings(params: {
  matchEmails: string[];
  matchNames: string[];
  maxPages?: number;
  maxResults?: number;
}): Promise<GrainRecording[]> {
  if (!grainConfigured()) return [];
  const { matchEmails, matchNames, maxPages = 10, maxResults = 25 } = params;

  const matched: GrainRecording[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (page < maxPages && matched.length < maxResults) {
    page++;
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    let body: any;
    try {
      body = await grainGet<any>(`/recordings${qs}`);
    } catch (err: any) {
      console.warn(`[grain] recordings page ${page} failed:`, err.message);
      break;
    }
    const rows: any[] = body?.recordings || body?.list || [];
    for (const r of rows) {
      const rec = normalizeRecording(r);
      if (hasIronbooksHost(rec) && matchesClient(rec, matchEmails, matchNames)) {
        matched.push(rec);
        if (matched.length >= maxResults) break;
      }
    }
    cursor = body?.cursor || null;
    if (!cursor) break;
  }

  // Enrich each match with detail (summary + action items) when the list
  // response didn't already include them.
  const enriched = await Promise.all(
    matched.map(async (rec) => {
      if (rec.summary && rec.actionItems.length) return rec;
      try {
        const detail = await grainGet<any>(`/recordings/${rec.id}?intelligence_notes_format=json`);
        const d = normalizeRecording({ ...detail, id: rec.id });
        return {
          ...rec,
          summary: rec.summary ?? d.summary,
          actionItems: rec.actionItems.length ? rec.actionItems : d.actionItems,
          participants: rec.participants.length ? rec.participants : d.participants,
          ironbooksHost: rec.ironbooksHost ?? d.ironbooksHost,
        };
      } catch (err: any) {
        console.warn(`[grain] detail ${rec.id} failed:`, err.message);
        return rec;
      }
    })
  );

  return enriched;
}

/**
 * Split a recording's action items into the client's vs the Ironbooks BK's
 * to-do lists, by matching the assignee name. Items assigned to the
 * ironbooks host (or another ironbooks participant) go to `bookkeeper`;
 * items matching the client's name/participants go to `client`; the rest
 * are `unassigned`.
 */
export function splitActionItems(
  rec: GrainRecording,
  clientNames: string[]
): { client: GrainActionItem[]; bookkeeper: GrainActionItem[]; unassigned: GrainActionItem[] } {
  const ironbooksNames = rec.participants
    .filter((p) => emailDomain(p.email) === IRONBOOKS_DOMAIN)
    .map((p) => (p.name || "").toLowerCase())
    .filter(Boolean);
  const clientLower = clientNames.map((n) => n.toLowerCase()).filter(Boolean);

  const out = { client: [] as GrainActionItem[], bookkeeper: [] as GrainActionItem[], unassigned: [] as GrainActionItem[] };
  for (const item of rec.actionItems) {
    const a = (item.assigneeName || "").toLowerCase();
    if (!a) { out.unassigned.push(item); continue; }
    if (ironbooksNames.some((n) => a.includes(n) || n.includes(a))) out.bookkeeper.push(item);
    else if (clientLower.some((n) => n.length > 2 && (a.includes(n) || n.includes(a)))) out.client.push(item);
    else out.client.push(item); // a named, non-ironbooks assignee defaults to the client side
  }
  return out;
}
