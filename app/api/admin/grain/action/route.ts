import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { rulesFromManualMatch, type MatchParticipant } from "@/lib/grain-matching";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/grain/action  — admin/lead only.
 *
 * Body: { recording_id, action, client_link_id? }
 *   match    { client_link_id } — manually link a recording to a client AND
 *                                 learn rules (participant email/name → client)
 *                                 so future calls with that person auto-match.
 *   unmatch  { client_link_id } — remove a match.
 *   ignore                       — mark "not a client" (hide from the queue).
 *   unignore                     — restore to the queue.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const recordingId = body.recording_id as string;
  const action = body.action as string;
  if (!recordingId || !action) {
    return NextResponse.json({ error: "recording_id and action required" }, { status: 400 });
  }

  switch (action) {
    case "ignore":
      await service.from("grain_recordings").update({ ignored: true, updated_at: new Date().toISOString() } as any).eq("id", recordingId);
      return NextResponse.json({ ok: true });

    case "unignore":
      await service.from("grain_recordings").update({ ignored: false, updated_at: new Date().toISOString() } as any).eq("id", recordingId);
      return NextResponse.json({ ok: true });

    case "unmatch": {
      if (!body.client_link_id) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
      await service.from("grain_recording_matches").delete()
        .eq("recording_id", recordingId).eq("client_link_id", body.client_link_id);
      return NextResponse.json({ ok: true });
    }

    case "match": {
      const clientLinkId = body.client_link_id as string;
      if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

      // Create the manual match.
      const { error: mErr } = await service.from("grain_recording_matches").upsert({
        recording_id: recordingId,
        client_link_id: clientLinkId,
        match_method: "manual",
        matched_by: user.id,
      } as any, { onConflict: "recording_id,client_link_id" });
      if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

      // Un-ignore (matching implies it IS a client).
      await service.from("grain_recordings").update({ ignored: false } as any).eq("id", recordingId);

      // Learn rules from this recording's participants → client, so future
      // calls with the same person auto-match.
      const { data: rec } = await service.from("grain_recordings").select("participants").eq("id", recordingId).single();
      const participants = ((rec as any)?.participants || []) as MatchParticipant[];
      const rules = rulesFromManualMatch(participants, clientLinkId);
      if (rules.length) {
        await service.from("grain_match_rules").upsert(
          rules.map((r) => ({ ...r, created_by: user.id })) as any,
          { onConflict: "rule_type,match_value,client_link_id" }
        );
      }

      await service.from("audit_log").insert({
        user_id: user.id,
        event_type: "grain_call_matched",
        request_payload: { recording_id: recordingId, client_link_id: clientLinkId, rules_learned: rules.length } as any,
      });

      return NextResponse.json({ ok: true, rules_learned: rules.length });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
