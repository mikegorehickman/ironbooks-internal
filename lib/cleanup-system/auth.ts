/**
 * Staff auth helpers for BS cleanup routes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = { auth: { getUser: () => Promise<any> }; from: (table: string) => any };

export interface StaffAuthResult {
  userId: string;
  role: string;
  isSenior: boolean;
}

export async function requireStaff(
  supabase: AnySupabase
): Promise<StaffAuthResult | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = (profile as any)?.role || "bookkeeper";
  // Neither clients nor billing-only admins are bookkeeping staff.
  if (role === "client" || role === "billing_admin") return null;

  return {
    userId: user.id,
    role,
    isSenior: ["admin", "lead"].includes(role),
  };
}

export async function requireOwnerOrSenior(
  service: AnySupabase,
  clientLinkId: string,
  userId: string,
  role: string
): Promise<{ ok: boolean; error?: string }> {
  if (["admin", "lead"].includes(role)) return { ok: true };
  if (role === "viewer") return { ok: false, error: "Viewer role is read-only" };

  const { data: client } = await service
    .from("client_links")
    .select("assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();

  if (!client) return { ok: false, error: "Client not found" };
  if ((client as any).assigned_bookkeeper_id !== userId) {
    return { ok: false, error: "Only the assigned bookkeeper or a lead/admin can modify this cleanup" };
  }
  return { ok: true };
}
