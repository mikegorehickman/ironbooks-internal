import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { checkExpenseAccounts } from "@/lib/qbo-stripe-execute";

/**
 * GET /api/clients/[id]/stripe-account-check?jurisdiction=US|CA
 * Pre-flight for Stripe recon: do the QBO accounts the write-back needs exist?
 * Surfaced on the New-recon form so a missing account is caught before
 * discovery, not after Execute. Fail-open: if we can't check (dead token etc.)
 * we return ok so we never block on our own error.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jurisdiction =
    new URL(request.url).searchParams.get("jurisdiction") === "CA" ? "CA" : "US";

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", id)
    .single();
  const realm = (client as any)?.qbo_realm_id;
  if (!realm) return NextResponse.json({ ok: true, missing: [], error: "No QBO realm" });

  try {
    const token = await getValidToken(id, service as any);
    const result = await checkExpenseAccounts(realm, token, jurisdiction);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ ok: true, missing: [], error: e?.message || "check failed" });
  }
}
