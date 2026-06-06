"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ClipboardCheck, ArrowRight, Loader2 } from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  cleanup_completed_at: string | null;
}

interface ActiveRun {
  client_link_id: string;
  id: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  discovering: "Discovering",
  reviewing: "In review",
  executing: "Executing",
};

export function BsCleanupPicker({
  clientLinks,
  activeRuns,
}: {
  clientLinks: ClientLink[];
  activeRuns: ActiveRun[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);

  const activeByClient = useMemo(() => {
    const map = new Map<string, ActiveRun>();
    for (const run of activeRuns) map.set(run.client_link_id, run);
    return map;
  }, [activeRuns]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clientLinks;
    return clientLinks.filter(
      (c) =>
        c.client_name.toLowerCase().includes(q) ||
        (c.state_province || "").toLowerCase().includes(q) ||
        c.jurisdiction.toLowerCase().includes(q)
    );
  }, [clientLinks, query]);

  function open(c: ClientLink) {
    setNavigatingTo(c.id);
    const active = activeByClient.get(c.id);
    if (active) {
      router.push(`/balance-sheet/${c.id}/cleanup/${active.id}`);
      return;
    }
    router.push(`/balance-sheet/${c.id}/cleanup`);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span className="font-bold uppercase tracking-wide text-[10px] mr-2">
          Pilot
        </span>
        Standalone balance sheet cleanup — test here before we wire it into the
        main 5-step Account Cleanup flow.
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-teal/10 flex-shrink-0">
            <ClipboardCheck size={18} className="text-teal" />
          </div>
          <div className="flex-1">
            <h2 className="font-bold text-navy">Pick a client</h2>
            <p className="text-xs text-ink-slate mt-0.5">
              {clientLinks.length} active client
              {clientLinks.length === 1 ? "" : "s"} · guided BS cleanup with
              module discovery, review, and approved QBO posting
            </p>
          </div>
        </div>

        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light"
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, jurisdiction, or state…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm"
          />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-slate">
            No clients match &ldquo;{query}&rdquo;.
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {filtered.map((c) => {
              const active = activeByClient.get(c.id);
              const isLoading = navigatingTo === c.id;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => open(c)}
                    disabled={navigatingTo !== null}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left disabled:opacity-60"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-navy truncate">
                          {c.client_name}
                        </span>
                        {active && (
                          <span className="text-[10px] font-semibold bg-teal/10 text-teal px-1.5 py-0.5 rounded">
                            {STATUS_LABEL[active.status] || active.status} · continue
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-slate mt-0.5">
                        {c.jurisdiction}
                        {c.state_province ? ` · ${c.state_province}` : ""}
                      </div>
                    </div>
                    {isLoading ? (
                      <Loader2 size={14} className="animate-spin text-teal" />
                    ) : (
                      <ArrowRight size={14} className="text-ink-light" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
