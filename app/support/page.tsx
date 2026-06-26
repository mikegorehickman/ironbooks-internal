import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /support — now points at our Freshdesk agent portal. Support moved to
 * Freshdesk (ironbooks.freshdesk.com); the in-house ticket desk is retired.
 * We can't iframe-embed Freshdesk's agent app (it sends X-Frame-Options:
 * DENY), so this server-redirects there instead. Staff-only gate kept so a
 * logged-out / client request bounces to login rather than straight out.
 */
const FRESHDESK_URL = "https://ironbooks.freshdesk.com/a/";

export default async function SupportPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) redirect("/dashboard");

  redirect(FRESHDESK_URL);
}
