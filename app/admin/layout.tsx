import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";

/**
 * Admin layout - gates ALL /admin/* routes to admin role.
 *
 * billing_admin is also allowed through: it's a restricted role that can only
 * see /admin/billing, and middleware already confines it there (any other
 * /admin/* path bounces back to /admin/billing). Without this exception it hits
 * an admin-layout reject → /dashboard → middleware → /admin/billing loop, so
 * the billing_admin can never actually reach the page.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role, is_active")
    .eq("id", user.id)
    .single<{ role: string; is_active: boolean | null }>();

  if (!profile || !profile.is_active || !["admin", "billing_admin"].includes(profile.role)) {
    redirect("/dashboard?error=admin_required");
  }

  return <>{children}</>;
}
