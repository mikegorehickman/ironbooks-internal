import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { normName, isIronbooks } from "@/lib/grain-matching";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/grain
 *
 * Returns this client's matched Grain recordings (summary + action items
 * split into client/bookkeeper to-dos) from the persisted cache — populated
 * by the backfill + the Call Matching tab. Internal roles only.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!(actor as any)?.role || (actor as any).role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Matched recording ids for this client.
  const { data: matches } = await service
    .from("grain_recording_matches")
    .select("recording_id")
    .eq("client_link_id", id);
  const recIds = ((matches as any[]) || []).map((m) => m.recording_id);
  if (recIds.length === 0) return NextResponse.json({ configured: true, recordings: [] });

  const { data: recs } = await service
    .from("grain_recordings")
    .select("id, title, url, start_datetime, duration, summary, host_name, host_email, participants, action_items")
    .in("id", recIds)
    .order("start_datetime", { ascending: false });

  // Resolve the client's contact name(s) for the to-do split.
  const { data: cl } = await service
    .from("client_links")
    .select("client_name, contact_first_name, contact_last_name")
    .eq("id", id)
    .single();
  const c = (cl as any) || {};
  const clientNames = [
    [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" "),
    c.client_name,
  ].filter(Boolean).map((n: string) => normName(n));

  const payload = ((recs as any[]) || []).map((r) => {
    const participants: any[] = r.participants || [];
    const ironbooksNames = participants
      .filter((p) => isIronbooks(p.email))
      .map((p) => normName(p.name)).filter(Boolean);

    const todos = { client: [] as any[], bookkeeper: [] as any[], unassigned: [] as any[] };
    for (const a of (r.action_items || []) as any[]) {
      const item = {
        text: a.text,
        status: a.status ?? null,
        dueDate: a.due_date ?? a.dueDate ?? null,
        assigneeName: a.assignee_name ?? a.assigneeName ?? null,
        transcriptUrl: a.transcript_url ?? a.transcriptUrl ?? null,
      };
      const an = normName(item.assigneeName);
      if (!an) todos.unassigned.push(item);
      else if (ironbooksNames.some((n) => an.includes(n) || n.includes(an))) todos.bookkeeper.push(item);
      else todos.client.push(item);
    }

    return {
      id: r.id,
      title: r.title,
      url: r.url,
      start_datetime: r.start_datetime,
      duration: r.duration,
      host: r.host_name || r.host_email ? { name: r.host_name, email: r.host_email } : null,
      summary: r.summary,
      participants: participants
        .filter((p) => !isIronbooks(p.email))
        .map((p) => ({ name: p.name, email: p.email })),
      todos,
    };
  });

  return NextResponse.json({ configured: true, recordings: payload });
}
