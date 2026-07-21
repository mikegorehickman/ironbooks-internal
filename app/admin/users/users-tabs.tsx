"use client";

import { useState } from "react";
import { Users, Building2 } from "lucide-react";
import { UsersManagement } from "./users-management";
import { ClientsManagement, type ClientRow } from "./clients-management";

export function UsersTabs({
  employees,
  clients,
  initialTab = "employees",
}: {
  employees: any[];
  clients: ClientRow[];
  /** Deep-link target (?tab=clients on the page) — clients used to be 3 clicks deep. */
  initialTab?: "employees" | "clients";
}) {
  const [tab, setTab] = useState<"employees" | "clients">(initialTab);

  return (
    <div>
      <div className="flex items-center gap-1 mb-5 border-b border-gray-200">
        <TabButton
          active={tab === "employees"}
          onClick={() => setTab("employees")}
          icon={<Users size={15} />}
          label="Employees"
          count={employees.length}
        />
        <TabButton
          active={tab === "clients"}
          onClick={() => setTab("clients")}
          icon={<Building2 size={15} />}
          label="Clients & Portal"
          count={clients.length}
        />
      </div>

      {tab === "employees" ? (
        <UsersManagement initialUsers={employees} />
      ) : (
        <ClientsManagement clients={clients} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
        active
          ? "border-teal text-teal"
          : "border-transparent text-ink-slate hover:text-navy"
      }`}
    >
      {icon}
      {label}
      <span
        className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
          active ? "bg-teal-light text-teal" : "bg-gray-100 text-ink-slate"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
