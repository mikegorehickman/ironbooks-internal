import { redirect } from "next/navigation";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getFlaggedClients } from "@/lib/flagged-data";
import { FlaggedQueue } from "@/app/approvals/flagged-queue";
import { Flag, ShieldAlert } from "lucide-react";

/**
 * Embedded flagged queue — V2's Oversight page renders this as a tab.
 * Data assembly lives in lib/flagged-data.ts (shared with /approvals).
 */
export async function FlaggedContent() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "lead"].includes(profile.role)) {
    return (
      <div className="rounded-2xl p-8 bg-amber-50 border border-amber-200 text-center">
        <ShieldAlert size={36} className="mx-auto text-amber-600 mb-3" />
        <h2 className="text-lg font-bold text-navy mb-2">Senior bookkeeper access required</h2>
        <p className="text-sm text-ink-slate">
          The Flagged Queue is reserved for senior bookkeepers, leads, and admins.
        </p>
      </div>
    );
  }

  const service = createServiceSupabase();
  const { clients, queryErrors } = await getFlaggedClients(service);

  return (
    <div>
      {queryErrors.length > 0 && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          Flagged queue failed to load: {queryErrors.join(" · ")}
        </div>
      )}
      {clients.length === 0 ? (
        <div className="rounded-xl bg-white border border-gray-200 px-8 py-16 text-center">
          <div className="rounded-full mx-auto mb-4 flex items-center justify-center w-14 h-14 bg-teal-light">
            <Flag size={24} className="text-teal" />
          </div>
          <h3 className="text-lg font-bold text-navy mb-1 tracking-tight">All clear</h3>
          <p className="text-sm text-ink-slate">No items waiting for senior review.</p>
        </div>
      ) : (
        <FlaggedQueue clients={clients} reviewerName={profile.full_name} />
      )}
    </div>
  );
}

/**
 * Standalone /flagged → /approvals (merged July 2026) — one senior queue
 * for statements, files, escalations, and flagged items.
 */
export default function FlaggedRedirect() {
  redirect("/approvals");
}
