"use client";

import Link from "next/link";
import { Sun, Inbox, ListTodo, BadgeCheck, HeartPulse, Gauge, type LucideIcon } from "lucide-react";

/**
 * Tab strip for the Home / Oversight hub pages — links that swap the ?tab=
 * query param so each hub renders one merged section at a time (only the
 * active section is server-rendered, so heavy tabs cost nothing until opened).
 *
 * Icons are resolved HERE, by tab key, from this client module. The hub pages
 * are Server Components, and passing a component reference (a lucide icon) as a
 * prop value from a Server Component to this Client Component is not
 * serializable across the RSC boundary — in a production build it throws a
 * server-side exception on load (that was the /home + /oversight crash). Keep
 * the crossing to plain strings/numbers only.
 */
const TAB_ICONS: Record<string, LucideIcon> = {
  today: Sun,
  inbox: Inbox,
  tasks: ListTodo,
  approvals: BadgeCheck,
  advisor: HeartPulse,
  fleet: Gauge,
};

export function HubTabs({
  basePath,
  tabs,
  active,
}: {
  basePath: string;
  tabs: { key: string; label: string; count?: number }[];
  active: string;
}) {
  return (
    <div className="px-8 pt-5">
      <div className="flex items-center gap-1 border-b border-gray-200">
        {tabs.map((t) => {
          const Icon = TAB_ICONS[t.key];
          const isActive = t.key === active;
          return (
            <Link
              key={t.key}
              href={`${basePath}?tab=${t.key}`}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                isActive
                  ? "border-teal text-navy"
                  : "border-transparent text-ink-slate hover:text-navy hover:border-gray-200"
              }`}
            >
              {Icon && <Icon size={15} />}
              {t.label}
              {typeof t.count === "number" && t.count > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-teal text-white text-[10px] font-bold">
                  {t.count}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
