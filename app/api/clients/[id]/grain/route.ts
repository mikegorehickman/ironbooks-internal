import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  grainConfigured,
  listClientGrainRecordings,
  splitActionItems,
} from "@/lib/grain";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/grain
 *
 * Returns the client's Ironbooks-hosted Grain recordings (summary +
 * action-items split into client vs bookkeeper to-dos). Internal roles only.
 * Matches recordings by the client's email(s) + contact name; only calls with
 * an @ironbooks.com host are included (enforced in lib/grain).
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
  const role = (actor as any)?.role;
  if (!role || role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!grainConfigured()) {
    return NextResponse.json({ configured: false, recordings: [] });
  }

  // Resolve the client's match keys: email + contact name + business name.
  const { data: cl } = await service
    .from("client_links")
    .select("client_name, client_email, contact_first_name, contact_last_name")
    .eq("id", id)
    .single();
  if (!cl) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const c = cl as any;
  const matchEmails = [c.client_email].filter(Boolean) as string[];

  // Also gather any portal-user emails for this client (they may have joined
  // the call under their login email rather than the client_links email).
  try {
    const { data: cu } = await (service as any)
      .from("client_users")
      .select("users(email)")
      .eq("client_link_id", id);
    for (const row of (cu || []) as any[]) {
      const e = row?.users?.email;
      if (e && !matchEmails.includes(e)) matchEmails.push(e);
    }
  } catch { /* client_users join optional */ }

  const contactName = [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ");
  const matchNames = [contactName, c.client_name].filter(Boolean) as string[];

  let recordings;
  try {
    recordings = await listClientGrainRecordings({ matchEmails, matchNames });
  } catch (e: any) {
    console.error("[grain route] fetch failed:", e.message);
    return NextResponse.json({ configured: true, error: "Could not reach Grain", recordings: [] }, { status: 502 });
  }

  const payload = recordings.map((rec) => ({
    id: rec.id,
    title: rec.title,
    url: rec.url,
    start_datetime: rec.startDatetime,
    duration: rec.durationLabel,
    host: rec.ironbooksHost ? { name: rec.ironbooksHost.name, email: rec.ironbooksHost.email } : null,
    summary: rec.summary,
    participants: rec.participants
      .filter((p) => (p.email || "").split("@")[1]?.toLowerCase() !== "ironbooks.com")
      .map((p) => ({ name: p.name, email: p.email })),
    todos: splitActionItems(rec, matchNames),
  }));

  return NextResponse.json({ configured: true, recordings: payload });
}
