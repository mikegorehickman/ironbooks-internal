import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import Link from "next/link";
import { Sun, Inbox, ListTodo } from "lucide-react";
import { TodayContent } from "../today/page";
import { InboxContent } from "../inbox/page";
import { TasksContent } from "../tasks/page";

export const dynamic = "force-dynamic";

/**
 * /home — the single daily surface (SNAP V2). Merges the three work queues —
 * Today (action queue), Inbox (client messages), Tasks (team to-dos) — into
 * one tabbed page by reusing each page's extracted content component. Tabs are
 * server-rendered links (?tab=) so only the active tab fetches. The standalone
 * /today, /inbox, /tasks routes stay live for V1.
 */
const TABS = [
  { id: "today", label: "Today", icon: Sun },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "tasks", label: "Tasks", icon: ListTodo },
] as const;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; viewas?: string }>;
}) {
  const sp = await searchParams;
  const tab = (["today", "inbox", "tasks"].includes(sp.tab || "")
    ? sp.tab
    : "today") as "today" | "inbox" | "tasks";

  return (
    <AppShell>
      <TopBar title="Home" subtitle="Your day — action queue, client messages, and team tasks" />
      <div className="px-8 pt-5">
        <div className="inline-flex items-center gap-1 rounded-xl bg-gray-100 p-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <Link
                key={t.id}
                href={`/home?tab=${t.id}`}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                  active ? "bg-white text-navy shadow-sm" : "text-ink-slate hover:text-navy"
                }`}
              >
                <Icon size={15} />
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>

      {tab === "today" && (
        <TodayContent searchParams={Promise.resolve({ viewas: sp.viewas })} />
      )}
      {tab === "inbox" && <InboxContent />}
      {tab === "tasks" && <TasksContent />}
    </AppShell>
  );
}
