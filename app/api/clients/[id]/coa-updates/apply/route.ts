import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboErrorResponse, fetchAllAccounts, createAccount } from "@/lib/qbo";
import { getNewCoaCategoriesForClient } from "@/lib/coa-updates";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Normalize an account name for existence matching — the master COA uses an
 *  en-dash + ampersand that QBO may store differently. Mirrors the bank-rules
 *  resolver so we don't create a duplicate of an account that already exists. */
function norm(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/–|—/g, "-")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * POST /api/clients/[id]/coa-updates/apply
 *
 * Creates the NEW master-COA categories (added since this client's last
 * cleanup) as accounts in the client's QuickBooks — idempotent: an account
 * whose name already exists is skipped. Does NOT reclassify anything; the
 * caller then kicks off the existing full_categorization reclass flow so the
 * AI can suggest moves into the freshly-created accounts.
 *
 * Auth: assigned bookkeeper or admin/lead.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, jurisdiction, qbo_realm_id, assigned_bookkeeper_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { categories } = await getNewCoaCategoriesForClient(service, {
    clientLinkId,
    jurisdiction: (client as any).jurisdiction,
  });
  if (categories.length === 0) {
    return NextResponse.json({ ok: true, created: [], skipped_existing: [], skipped_no_type: [], errors: [] });
  }

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const realmId = (client as any).qbo_realm_id;

    const existing = await fetchAllAccounts(realmId, accessToken);
    const idByName = new Map<string, string>();
    for (const a of existing) idByName.set(norm(a.Name), a.Id);

    // Parents (no parent_account_name) first so children can resolve them.
    const ordered = [...categories].sort(
      (a, b) => (a.parent_account_name ? 1 : 0) - (b.parent_account_name ? 1 : 0)
    );

    const created: string[] = [];
    const skipped_existing: string[] = [];
    const skipped_no_type: string[] = [];
    const errors: string[] = [];

    for (const cat of ordered) {
      if (idByName.has(norm(cat.account_name))) {
        skipped_existing.push(cat.account_name);
        continue;
      }
      if (!cat.qbo_account_type || !cat.qbo_account_subtype) {
        skipped_no_type.push(cat.account_name);
        continue;
      }
      // Link to parent only if it already exists in this client's QBO;
      // otherwise create top-level rather than fail on a missing parent.
      const parentRefId = cat.parent_account_name
        ? idByName.get(norm(cat.parent_account_name))
        : undefined;
      try {
        const acct = await createAccount(realmId, accessToken, {
          name: cat.account_name,
          accountType: cat.qbo_account_type,
          accountSubType: cat.qbo_account_subtype,
          parentRefId,
        });
        idByName.set(norm(acct.Name), acct.Id);
        created.push(cat.account_name);
      } catch (e: any) {
        errors.push(`${cat.account_name}: ${String(e?.message || e).slice(0, 160)}`);
      }
    }

    await service.from("audit_log").insert({
      event_type: "coa_new_categories_applied",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        created,
        skipped_existing,
        skipped_no_type,
        errors,
      } as any,
    });

    return NextResponse.json({ ok: true, created, skipped_existing, skipped_no_type, errors });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
