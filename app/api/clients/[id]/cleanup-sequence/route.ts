import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  readCleanupSequence,
  isCleanupStepKey,
  isCleanupStepStatus,
  type CleanupSequenceState,
} from "@/lib/cleanup-sequence";

export const dynamic = "force-dynamic";

/**
 * Cleanup Sequence state for one client (the 8-step spine on the Cleanup tab).
 *
 * GET   → { sequence } — the persisted per-step status (client_links.cleanup_sequence).
 * PATCH → set one step's status: body { step, status, note? }. A bookkeeper
 *         marking a step done/skipped/active/pending. Returns the merged state.
 *
 * `[id]` is the client_link id.
 */
async function authorize() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("id, role, full_name, email")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, actor, service };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const auth = await authorize();
  if ("error" in auth) return auth.error;
  const { service } = auth;

  // Resilient to migration 137 not yet being applied: if the column doesn't
  // exist yet, fall back to an empty sequence rather than 400-ing the tab.
  const { data: row, error } = await service
    .from("client_links")
    .select("cleanup_sequence")
    .eq("id", id)
    .single();
  if (error) {
    return NextResponse.json({
      sequence: readCleanupSequence(null),
      persisted: false,
    });
  }
  if (!row) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  return NextResponse.json({ sequence: readCleanupSequence(row as any), persisted: true });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const auth = await authorize();
  if ("error" in auth) return auth.error;
  const { user, actor, service } = auth;

  let body: { step?: string; status?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isCleanupStepKey(body.step)) {
    return NextResponse.json({ error: "Unknown cleanup step" }, { status: 400 });
  }
  if (!isCleanupStepStatus(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : undefined;

  // Read-modify-write the jsonb so we only touch the one step and keep the rest.
  const { data: row, error: readErr } = await service
    .from("client_links")
    .select("cleanup_sequence")
    .eq("id", id)
    .single();
  if (readErr) {
    // Almost always: migration 137 (cleanup_sequence column) not applied yet.
    return NextResponse.json(
      {
        error:
          "Cleanup step status can't be saved yet — run migration 137 (adds client_links.cleanup_sequence).",
        reason: "not_migrated",
      },
      { status: 409 }
    );
  }
  if (!row) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const current: CleanupSequenceState = readCleanupSequence(row as any);
  const nowIso = new Date().toISOString();
  const actorName = (actor as any)?.full_name || (actor as any)?.email || user.id;
  const next: CleanupSequenceState = {
    steps: {
      ...current.steps,
      [body.step]: {
        status: body.status,
        note,
        at: nowIso,
        by: actorName,
      },
    },
  };

  const { error: updErr } = await (service as any)
    .from("client_links")
    .update({ cleanup_sequence: next })
    .eq("id", id);
  if (updErr) {
    return NextResponse.json(
      { error: `Couldn't save step status — ${updErr.message}` },
      { status: 500 }
    );
  }

  // Audit trail — queryable from /admin/audit (who moved which cleanup step).
  await service.from("audit_log").insert({
    event_type: "cleanup_step_updated",
    user_id: user.id,
    request_payload: {
      client_link_id: id,
      step: body.step,
      status: body.status,
      note: note || null,
      by: actorName,
      at: nowIso,
    } as any,
  });

  return NextResponse.json({ ok: true, sequence: next });
}
