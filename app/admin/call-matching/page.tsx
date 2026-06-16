import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CallMatchingClient } from "./call-matching-client";

export const dynamic = "force-dynamic";

/**
 * /admin/call-matching — admin/lead queue of Ironbooks-hosted Grain calls
 * that didn't auto-match to a client. Pick the client (learns a rule for
 * next time) or mark "not a client". Also shows already-matched calls for
 * review / re-assignment.
 */
export default async function CallMatchingPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  // Recordings with an Ironbooks host. Split into unmatched (no rows in the
  // matches table) vs matched, in JS.
  const { data: recs } = await service
    .from("grain_recordings")
    .select("id, title, url, start_datetime, duration, summary, host_name, participants, ignored")
    .eq("has_ironbooks_host", true)
    .order("start_datetime", { ascending: false })
    .limit(500);

  const recordings = (recs as any[]) || [];
  const recIds = recordings.map((r) => r.id);

  const matchByRec = new Map<string, { client_link_id: string; match_method: string }[]>();
  if (recIds.length) {
    const { data: matches } = await service
      .from("grain_recording_matches")
      .select("recording_id, client_link_id, match_method")
      .in("recording_id", recIds);
    for (const m of (matches as any[]) || []) {
      const arr = matchByRec.get(m.recording_id) || [];
      arr.push({ client_link_id: m.client_link_id, match_method: m.match_method });
      matchByRec.set(m.recording_id, arr);
    }
  }

  const { data: clientRows } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("is_active", true)
    .order("client_name");
  const clients = ((clientRows as any[]) || []).map((c) => ({ id: c.id, name: c.client_name }));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const enriched = recordings.map((r) => {
    const matches = (matchByRec.get(r.id) || []).map((m) => ({
      ...m,
      client_name: clientName.get(m.client_link_id) || "(unknown)",
    }));
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      start_datetime: r.start_datetime,
      duration: r.duration,
      summary: r.summary,
      host_name: r.host_name,
      ignored: r.ignored,
      participants: (r.participants || []).filter(
        (p: any) => (p.email || "").split("@")[1]?.toLowerCase() !== "ironbooks.com"
      ),
      matches,
    };
  });

  const unmatched = enriched.filter((r) => r.matches.length === 0 && !r.ignored);
  const matched = enriched.filter((r) => r.matches.length > 0);
  const ignored = enriched.filter((r) => r.matches.length === 0 && r.ignored);

  return (
    <AppShell>
      <TopBar
        title="Call Matching"
        subtitle={`${unmatched.length} unmatched · ${matched.length} matched · ${ignored.length} ignored`}
      />
      <div className="px-8 py-6">
        <CallMatchingClient
          unmatched={unmatched}
          matched={matched}
          ignored={ignored}
          clients={clients}
        />
      </div>
    </AppShell>
  );
}
