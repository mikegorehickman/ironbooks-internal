import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { TasksBoard, type Task, type StaffOption, type ClientOption } from "./tasks-board";

export const dynamic = "force-dynamic";

/**
 * /tasks — the internal team task board (replaces DoubleHQ's non-closing tasks).
 * Internal staff only; clients are kept out of all bookkeeper routes by
 * middleware. Tasks are fetched flat and enriched with assignee/creator/client
 * names here so the board renders without per-row joins.
 */
export async function TasksContent() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: me } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  if ((me as any)?.role === "client") redirect("/portal");

  const [tasksRes, staffRes, clientsRes] = await Promise.all([
    (service as any).from("team_tasks").select("*"),
    service.from("users")
      .select("id, full_name, role")
      .in("role", ["admin", "lead", "bookkeeper", "viewer"])
      .eq("is_active", true)
      .order("full_name"),
    service.from("client_links")
      .select("id, client_name")
      .eq("is_active", true)
      .order("client_name"),
  ]);

  const staff: StaffOption[] = ((staffRes.data as any[]) || []).map((u) => ({
    id: u.id,
    name: u.full_name || "(no name)",
  }));
  const clients: ClientOption[] = ((clientsRes.data as any[]) || []).map((c) => ({
    id: c.id,
    name: c.client_name || "(unnamed)",
  }));
  const staffById = new Map(staff.map((s) => [s.id, s.name]));
  const clientById = new Map(clients.map((c) => [c.id, c.name]));

  const tasks: Task[] = ((tasksRes.data as any[]) || []).map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status,
    priority: t.priority,
    assignee_id: t.assignee_id,
    assignee_name: t.assignee_id ? staffById.get(t.assignee_id) || "—" : null,
    client_link_id: t.client_link_id,
    client_name: t.client_link_id ? clientById.get(t.client_link_id) || "—" : null,
    due_date: t.due_date,
    created_at: t.created_at,
    completed_at: t.completed_at,
  }));

  return (
    <div className="px-8 py-6">
      <TasksBoard
        initialTasks={tasks}
        staff={staff}
        clients={clients}
        currentUserId={user.id}
      />
    </div>
  );
}

/** Standalone /tasks — wraps the shared TasksContent in the app shell (V1). */
export default async function TasksPage() {
  return (
    <AppShell>
      <TopBar title="Tasks" subtitle="Team to-do board — assign, track, and clear work" />
      <TasksContent />
    </AppShell>
  );
}
