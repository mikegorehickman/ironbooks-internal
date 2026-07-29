import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, fetchAllAccountsIncludingInactive, qboErrorResponse } from "@/lib/qbo";

/**
 * GET /api/clients/[id]/deleted-accounts   (READ-ONLY)
 *
 * The client's DELETED (inactive) P&L accounts, for the "Deleted account
 * cleanup" tool on the client P&L. QBO appends " (deleted)" to an account's
 * Name when it's deactivated but still reserves the name — so a delete-and-
 * recreate (or a master-COA standardization) leaves a deleted twin of a live
 * account, and any transaction still posting to the old id lingers on the P&L
 * as "Painting Revenue (deleted)".
 *
 * Returns each deleted P&L account with its authoritative id + a suggested
 * target: the LIVE account of the same base name and classification (the twin).
 * The tool defaults each row's reclass target to that twin, so consolidating a
 * deleted account onto its live version is one click. Balances/activity come
 * from the P&L the caller already rendered; this endpoint only supplies the
 * reliable ids + twin (the client's active-only account list can't see them).
 *
 * Bookkeeper / admin / lead (internal only — clients never see this).
 */
export const dynamic = "force-dynamic";

/** Lowercase + normalize dashes/spaces. Keeps "(deleted)" unless `stripDeleted`. */
function norm(name: string | null | undefined, stripDeleted: boolean): string {
  let s = String(name ?? "").toLowerCase().replace(/[–—−]/g, "-");
  if (stripDeleted) s = s.replace(/\s*\(deleted\)\s*$/i, "");
  return s.replace(/\s+/g, " ").trim();
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role;
  if (!role || role === "client") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client || !(client as any).qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or QBO not connected" }, { status: 404 });
  }
  if (!(client as any).is_active) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);
    const accounts = await fetchAllAccountsIncludingInactive(realm, token);

    const isPL = (a: any) => a.Classification === "Revenue" || a.Classification === "Expense";

    // Live P&L accounts keyed by base name + classification → twin lookup.
    const liveByKey = new Map<string, any>();
    for (const a of accounts) {
      if (a.Active === false || !isPL(a)) continue;
      const key = `${a.Classification}::${norm(a.Name, true)}`;
      if (!liveByKey.has(key)) liveByKey.set(key, a);
    }

    const deleted = accounts
      .filter((a) => a.Active === false && isPL(a))
      .map((a) => {
        const twin = liveByKey.get(`${a.Classification}::${norm(a.Name, true)}`);
        return {
          id: a.Id,
          name: a.Name,
          fullyQualifiedName: (a as any).FullyQualifiedName || a.Name,
          classification: a.Classification,
          accountType: (a as any).AccountType || "",
          // Key the UI can match against its own P&L rows (the live account name
          // never carries "(deleted)", so match on the literal deleted name).
          matchName: norm(a.Name, false),
          suggested_target: twin
            ? { id: twin.Id, name: (twin as any).FullyQualifiedName || twin.Name }
            : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ accounts: deleted });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
