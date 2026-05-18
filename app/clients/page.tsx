import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { sweepStaleJobs } from "@/lib/stale-jobs";
import { Plus } from "lucide-react";
import { ClientsList } from "./clients-list";

export default async function ClientsPage() {
  // Watchdog: auto-fail any job that's been hung in `executing` past its
  // window before we render. Cheap (indexed UPDATEs, usually 0 rows) and
  // means a bookkeeper hitting the clients page after a silent worker
  // crash sees the row unblocked instead of a phantom "running" spinner.
  // Errors are swallowed — never let the watchdog break page load.
  await sweepStaleJobs().catch((e) =>
    console.warn("[clients] sweepStaleJobs failed:", e?.message)
  );

  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("users").select("role, full_name").eq("id", user.id).single()
    : { data: null };

  const canEdit = profile && ["admin", "lead"].includes(profile.role);

  const [clientsRes, linksRes, bookkeepersRes, resumableCoaRes] = await Promise.all([
    supabase.from("client_list_view").select("*").order("client_name"),
    // client_list_view doesn't expose double_client_name or stripe fields, pull from client_links and merge
    supabase.from("client_links").select("id, double_client_name, stripe_connection_status, due_date"),
    supabase
      .from("users")
      .select("id, full_name, avatar_url")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper"])
      .order("full_name"),
    // Resumable cleanup jobs — anything mid-flight where re-execute would
    // actually do something useful. Status 'cancelled' is excluded
    // because cancel flags all pending actions, so re-execute is a no-op
    // (the bookkeeper should start a fresh cleanup instead).
    supabase
      .from("coa_jobs")
      .select("id, client_link_id, status, updated_at, execution_started_at")
      .in("status", ["in_review", "executing", "failed"])
      .order("updated_at", { ascending: false }),
  ]);

  const linksData = linksRes.data || [];
  const nameById = new Map<string, string | null>(
    linksData.map((l) => [l.id, l.double_client_name ?? null])
  );
  const stripeStatusById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).stripe_connection_status ?? null])
  );
  const dueDateById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).due_date ?? null])
  );

  // Most recent resumable COA job per client. The map's `.set` only
  // writes on first insert because the query is ordered desc; first
  // wins → newest. That's what the Continue button routes to.
  const resumableJobByClient = new Map<string, { id: string; status: string }>();
  for (const j of resumableCoaRes.data || []) {
    if (!j.client_link_id) continue;
    if (resumableJobByClient.has(j.client_link_id)) continue;
    resumableJobByClient.set(j.client_link_id, { id: j.id, status: j.status });
  }

  const enrichedClients = (clientsRes.data || []).map((c) => ({
    ...c,
    double_client_name: c.id ? nameById.get(c.id) ?? null : null,
    stripe_connection_status: c.id ? stripeStatusById.get(c.id) ?? null : null,
    due_date: c.id ? dueDateById.get(c.id) ?? null : null,
    resumable_job: c.id ? resumableJobByClient.get(c.id) ?? null : null,
  }));

  return (
    <AppShell>
      <TopBar
        title="Clients"
        subtitle={`${enrichedClients.length} clients`}
        actions={
          <a
            href="/api/qbo/connect"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
          >
            <Plus size={16} />
            Connect QuickBooks Client
          </a>
        }
      />
      <div className="px-8 py-6">
        <ClientsList
          initialClients={enrichedClients}
          bookkeepers={bookkeepersRes.data || []}
          currentUserId={user?.id || ""}
          canEdit={!!canEdit}
        />
      </div>
    </AppShell>
  );
}
