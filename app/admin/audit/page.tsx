import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { queryAuditLog } from "@/lib/audit-query";
import { AuditLogViewer } from "./audit-log-viewer";

export default async function AuditPage() {
  const supabase = await createServerSupabase();

  // Reads audit_log directly. This used to read `recent_activity_feed`, a view
  // capped at 500 rows — so the page could only ever see the last ~29 hours of a
  // 23,211-row log, and reported "no events" for anything older.
  const service = createServiceSupabase();
  const [trail, { data: users }, { data: clients }] = await Promise.all([
    queryAuditLog(service, { limit: 200 }),
    supabase.from("users").select("id, full_name").eq("is_active", true).order("full_name"),
    supabase.from("client_links").select("id, client_name").eq("is_active", true).order("client_name"),
  ]);

  return (
    <AppShell>
      <TopBar
        title="Audit Log"
        subtitle="Search all actions by user, client, date, or event type — for compliance review"
      />
      <div className="px-8 py-6">
        <AuditLogViewer
          initialEvents={trail.rows}
          initialNotes={trail.notes}
          users={users || []}
          clients={clients || []}
        />
      </div>
    </AppShell>
  );
}
