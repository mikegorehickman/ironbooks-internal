import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/freshdesk/unread
 *
 * "Unread" support-ticket count for the dashboard banner.
 *
 * Freshdesk's API exposes no per-agent viewed/read flag, so we count tickets
 * where the LAST WORD IS THE CUSTOMER'S — the closest real signal to unread:
 *   - NEW tickets (no agent has replied yet), plus
 *   - tickets where the customer replied after the agent's last reply.
 * A ticket drops off as soon as an agent replies or resolves it. (Merely
 * opening a ticket in Freshdesk can't clear it — view-tracking isn't in the
 * public API.)
 *
 * Mechanics: customer replies auto-reopen tickets in Freshdesk, so everything
 * we care about sits in status Open (2). We list Open tickets with
 * include=stats (agent_responded_at / requester_responded_at) and filter:
 *   needs_attention = no agent reply yet
 *                     OR requester_responded_at > agent_responded_at
 *
 * Env:
 *   FRESHDESK_DOMAIN   e.g. "ironbooks"  (→ ironbooks.freshdesk.com)
 *   FRESHDESK_API_KEY  an agent's API key (Freshdesk → Profile settings)
 *
 * Fails soft in every case ({ count: 0 }) — a support-desk hiccup must never
 * break the dashboard. Internal staff only. A 60s in-memory cache keeps us
 * far from Freshdesk rate limits with the whole team on the dashboard.
 */

let cached: { count: number; at: number } | null = null;
const CACHE_MS = 60_000;
const MAX_PAGES = 3; // 300 open tickets is plenty for a banner count

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Staff only — portal clients have no business seeing the support queue.
  const service = createServiceSupabase();
  const { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || (profile as any).role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const domain = process.env.FRESHDESK_DOMAIN;
  const apiKey = process.env.FRESHDESK_API_KEY;
  if (!domain || !apiKey) {
    // Not configured — banner simply never shows.
    return NextResponse.json({ count: 0, configured: false });
  }

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json({ count: cached.count, cached: true });
  }

  const auth = `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
  // The list endpoint defaults to the last 30 days — widen to 90 so an old
  // ticket a customer just bumped still counts.
  const updatedSince = new Date(Date.now() - 90 * 86_400_000).toISOString();

  try {
    let count = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(
        `https://${domain}.freshdesk.com/api/v2/tickets?include=stats&order_by=updated_at&per_page=100&page=${page}&updated_since=${encodeURIComponent(updatedSince)}`,
        { headers: { Authorization: auth }, cache: "no-store", signal: controller.signal }
      );
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`[freshdesk/unread] Freshdesk responded ${res.status}`);
        return NextResponse.json({ count: 0, error: `freshdesk_${res.status}` });
      }

      const tickets = (await res.json().catch(() => [])) as any[];
      if (!Array.isArray(tickets)) break;

      for (const t of tickets) {
        if (t.status !== 2) continue; // customer replies reopen → Open covers all
        const s = t.stats || {};
        const agentAt = s.agent_responded_at ? Date.parse(s.agent_responded_at) : null;
        const requesterAt = s.requester_responded_at ? Date.parse(s.requester_responded_at) : null;
        const needsAttention =
          agentAt === null || (requesterAt !== null && requesterAt > agentAt);
        if (needsAttention) count++;
      }

      if (tickets.length < 100) break; // last page
    }

    cached = { count, at: Date.now() };
    return NextResponse.json({ count });
  } catch (e: any) {
    console.warn(`[freshdesk/unread] fetch failed: ${e?.message || "unknown"}`);
    return NextResponse.json({ count: 0, error: "fetch_failed" });
  }
}
