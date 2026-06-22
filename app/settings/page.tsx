import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { SignatureEditor } from "./signature-editor";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: me } = await service
    .from("users")
    .select("full_name, email, title, phone, booking_url, avatar_url, signature_enabled, role")
    .eq("id", user.id)
    .single();
  if (!me || !["admin", "lead", "bookkeeper", "viewer"].includes((me as any).role)) redirect("/dashboard");

  return (
    <AppShell>
      <TopBar title="Settings" subtitle="Your email signature" />
      <div className="px-8 py-6 max-w-3xl">
        <SignatureEditor
          initial={{
            full_name: (me as any).full_name,
            email: (me as any).email,
            title: (me as any).title,
            phone: (me as any).phone,
            booking_url: (me as any).booking_url,
            avatar_url: (me as any).avatar_url,
            signature_enabled: (me as any).signature_enabled !== false,
          }}
        />
      </div>
    </AppShell>
  );
}
