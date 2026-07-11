import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import {
  fetchAllAccounts,
  getValidToken,
  renameAccount,
  inactivateAccount,
  reactivateAccount,
  reparentAccount,
  qboErrorResponse,
} from "@/lib/qbo";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/clients/[id]/bs-coa/account/[accountId]
 *
 * Modify an existing BS account in QBO.
 *
 * Body — pass ONE of:
 *   { action: "rename",      new_name: string }
 *   { action: "inactivate" }
 *   { action: "reactivate" }
 *   { action: "reparent",    new_parent_id: string }
 *
 * Owner bookkeeper or admin/lead only. Each action is a thin wrapper around
 * the existing lib/qbo.ts helpers so all the sub-account / parent-ref
 * preservation rules apply automatically.
 *
 * On inactivate, QBO will reject if the account has any historical
 * transactions — we surface the error verbatim so the bookkeeper can
 * decide (e.g. inactivate via QBO UI which has a different protection
 * model, or accept the error and leave it active).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; accountId: string }> }
) {
  const { id: clientLinkId, accountId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id")
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

  const body = await request.json();
  const action = String(body.action || "");

  let accessToken: string;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  // Fetch the current account snapshot — every QBO sparse update needs the
  // SyncToken, and rename/inactivate require AccountType + sub-account
  // preservation. Doing it server-side (rather than trusting the client)
  // avoids stale-syncToken errors when multiple browser tabs are open.
  let all;
  try {
    all = await fetchAllAccounts((client as any).qbo_realm_id, accessToken);
  } catch (err: any) {
    return qboErrorResponse(err);
  }
  const current = all.find((a) => a.Id === accountId);
  if (!current) {
    return NextResponse.json({ error: "Account not found in QBO" }, { status: 404 });
  }

  try {
    if (action === "rename") {
      const newName = String(body.new_name || "").trim();
      if (!newName) {
        return NextResponse.json({ error: "new_name is required" }, { status: 400 });
      }
      if (newName === current.Name) {
        return NextResponse.json({ ok: true, noop: true, message: "Name unchanged" });
      }
      const updated = await renameAccount(
        (client as any).qbo_realm_id,
        accessToken,
        accountId,
        (current as any).SyncToken,
        newName,
        { currentAccount: current }
      );
      return NextResponse.json({
        ok: true,
        account: { id: updated.Id, name: updated.Name, account_type: updated.AccountType },
      });
    }

    if (action === "inactivate") {
      const updated = await inactivateAccount(
        (client as any).qbo_realm_id,
        accessToken,
        accountId,
        (current as any).SyncToken,
        current
      );
      return NextResponse.json({
        ok: true,
        account: { id: updated.Id, name: updated.Name, active: updated.Active },
      });
    }

    if (action === "reactivate") {
      const updated = await reactivateAccount(
        (client as any).qbo_realm_id,
        accessToken,
        accountId,
        (current as any).SyncToken,
        current
      );
      return NextResponse.json({
        ok: true,
        account: { id: updated.Id, name: updated.Name, active: updated.Active },
      });
    }

    if (action === "reparent") {
      const newParentId = String(body.new_parent_id || "").trim();
      if (!newParentId) {
        return NextResponse.json({ error: "new_parent_id is required" }, { status: 400 });
      }
      if (newParentId === accountId) {
        return NextResponse.json(
          { error: "Cannot re-parent an account to itself" },
          { status: 400 }
        );
      }
      // Sanity: new parent must exist and be the same AccountType as the
      // account being re-parented (QBO rejects type mismatches with 2010).
      const newParent = all.find((a) => a.Id === newParentId);
      if (!newParent) {
        return NextResponse.json({ error: "Target parent not found in QBO" }, { status: 404 });
      }
      if (newParent.AccountType !== current.AccountType) {
        return NextResponse.json(
          {
            error: `Type mismatch — can't re-parent a ${current.AccountType} under a ${newParent.AccountType}. Parent and child must share AccountType.`,
          },
          { status: 400 }
        );
      }
      const updated = await reparentAccount(
        (client as any).qbo_realm_id,
        accessToken,
        accountId,
        (current as any).SyncToken,
        newParentId,
        current as any
      );
      return NextResponse.json({
        ok: true,
        account: { id: updated.Id, name: updated.Name, parent_id: newParentId },
      });
    }

    return NextResponse.json(
      { error: `Unknown action '${action}' (expected rename / inactivate / reactivate / reparent)` },
      { status: 400 }
    );
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
