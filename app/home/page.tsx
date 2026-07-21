import { AppShell } from "@/components/AppShell";
import { HubTabs } from "@/components/HubTabs";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import TodayPage from "@/app/today/page";
import InboxPage from "@/app/inbox/page";
import TasksPage from "@/app/tasks/page";

export const dynamic = "force-dynamic";

/**
 * /home — the single daily landing for doers. Merges Today (daily review),
 * Inbox (client messages) and Tasks (team to-do) into one hub with a tab
 * strip; each tab server-renders the existing surface inside the shared shell
 * (AppShell is nesting-aware, so the inner page's own <AppShell> renders bare).
 * Only the active tab renders, so heavy tabs cost nothing until opened.
 */
const TABS = [
  { key: "today", label: "Today" },
  { key: "inbox", label: "Inbox" },
  { key: "tasks", label: "Tasks" },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; viewas?: string }>;
}) {
  const sp = await searchParams;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (role === "client") redirect("/portal");

  const active = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "today";

  return (
    <AppShell>
      <HubTabs basePath="/home" tabs={TABS} active={active} />
      {active === "today" && <TodayPage searchParams={Promise.resolve({ viewas: sp.viewas })} />}
      {active === "inbox" && <InboxPage />}
      {active === "tasks" && <TasksPage />}
    </AppShell>
  );
}
