"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, Users, Building2, ArrowRight } from "lucide-react";

/**
 * Admin quick search — jump to any client or employee without walking lists.
 * Pure client-side filter over the lightweight name lists the page passes in.
 */
export function AdminSearch({
  clients,
  employees,
}: {
  clients: { id: string; name: string }[];
  employees: { id: string; name: string }[];
}) {
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return { clients: [] as typeof clients, employees: [] as typeof employees };
    return {
      clients: clients.filter((c) => c.name.toLowerCase().includes(needle)).slice(0, 6),
      employees: employees.filter((e) => e.name.toLowerCase().includes(needle)).slice(0, 4),
    };
  }, [q, clients, employees]);

  const open = q.trim().length >= 2;

  return (
    <div className="relative">
      <div className="flex items-center gap-2.5 bg-white border border-cardline rounded-lg shadow-card px-4 py-2.5">
        <Search size={15} className="text-ink-light flex-shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Jump to a client or employee…"
          className="flex-1 text-sm text-navy placeholder:text-ink-light outline-none bg-transparent"
        />
        {q && (
          <button onClick={() => setQ("")} className="text-xs font-semibold text-ink-light hover:text-navy">
            clear
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-cardline rounded-lg shadow-card overflow-hidden">
          {results.clients.length === 0 && results.employees.length === 0 && (
            <div className="px-4 py-3 text-[13.5px] text-ink-light text-center">No matches.</div>
          )}
          {results.clients.map((c) => (
            <Link
              key={c.id}
              href={`/clients/${c.id}`}
              className="flex items-center gap-2.5 px-4 py-2.5 border-b border-hairline last:border-b-0 hover:bg-teal-lighter transition-colors"
            >
              <Building2 size={14} className="text-teal flex-shrink-0" />
              <span className="text-sm font-semibold text-navy flex-1 truncate">{c.name}</span>
              <span className="text-[11px] text-ink-light">client</span>
              <ArrowRight size={13} className="text-gold" />
            </Link>
          ))}
          {results.employees.map((e) => (
            <Link
              key={e.id}
              href={`/admin/users/${e.id}`}
              className="flex items-center gap-2.5 px-4 py-2.5 border-b border-hairline last:border-b-0 hover:bg-teal-lighter transition-colors"
            >
              <Users size={14} className="text-ink-slate flex-shrink-0" />
              <span className="text-sm font-semibold text-navy flex-1 truncate">{e.name}</span>
              <span className="text-[11px] text-ink-light">employee</span>
              <ArrowRight size={13} className="text-gold" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
