import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BulkEmailClient } from "./bulk-email-client";

export const dynamic = "force-dynamic";

export default async function BulkEmailPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, email, full_name, title, phone, booking_url, avatar_url, signature_enabled").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead"].includes(role)) redirect("/dashboard");
  const a = (actor as any) || {};

  return (
    <AppShell>
      <TopBar title="Bulk email" subtitle="Email some or all clients · operational + marketing · unsubscribe-aware" />
      <div className="px-8 py-6 max-w-6xl">
        <BulkEmailClient
          senderEmail={a.email || ""}
          senderName={a.full_name || "Ironbooks"}
          senderSignature={{
            full_name: a.full_name, email: a.email, title: a.title,
            phone: a.phone, booking_url: a.booking_url, avatar_url: a.avatar_url,
          }}
        />
      </div>
    </AppShell>
  );
}
