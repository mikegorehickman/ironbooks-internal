import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { listCustomersByEmail, searchStripeCustomers } from "@/lib/stripe-billing";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/billing/stripe-candidates?client_link_id=…
 * Closest Stripe customers for a client — exact email match first, then a
 * name search — so an admin can hand-pick the right one. Admin/lead only.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const clientLinkId = new URL(request.url).searchParams.get("client_link_id");
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  const { data: c } = await service
    .from("client_links")
    .select("client_email, client_name, legal_business_name")
    .eq("id", clientLinkId)
    .single();
  if (!c) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const byId = new Map<string, any>();
  const add = (list: any[], how: string) => {
    for (const x of list || []) if (x?.id && !byId.has(x.id)) byId.set(x.id, { ...x, matched_on: how });
  };
  try { if ((c as any).client_email) add(await listCustomersByEmail((c as any).client_email), "email"); } catch {}
  try {
    const name = (c as any).legal_business_name || (c as any).client_name || "";
    if (name.trim()) add(await searchStripeCustomers(name, 8), "name");
  } catch {}

  return NextResponse.json({
    client_email: (c as any).client_email || null,
    candidates: Array.from(byId.values()).slice(0, 12).map((x) => ({
      id: x.id, name: x.name || null, email: x.email || null, matched_on: x.matched_on,
    })),
  });
}
