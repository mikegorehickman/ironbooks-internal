"use client";

import { useState, useEffect } from "react";
import { RedoWarning } from "@/components/RedoWarning";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Search, ArrowRight, Loader2, MapPin, CheckCircle2, Clock, Zap } from "lucide-react";
import type { Database } from "@/lib/database.types";

type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

export function NewRulesForm({
  clientLinks,
  recentJobs,
}: {
  clientLinks: ClientLink[];
  recentJobs: any[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ClientLink | null>(null);
  const [fromReclassId, setFromReclassId] = useState<string | null>(null);

  // Auto-select from URL deep link
  useEffect(() => {
    const clientId = searchParams.get("client");
    const fromReclass = searchParams.get("from_reclass");
    if (clientId && !selected) {
      const found = clientLinks.find((c) => c.id === clientId);
      if (found) setSelected(found);
    }
    if (fromReclass) setFromReclassId(fromReclass);
  }, [searchParams, clientLinks]);
  const [months, setMonths] = useState(6);
  const [starting, setStarting] = useState(false);
  const [redoAllowed, setRedoAllowed] = useState(true);

  // Reuse the analysis window carried from the upstream reclass step
  // (?months=), so the bookkeeper doesn't re-pick the period.
  useEffect(() => {
    const m = Number(searchParams.get("months"));
    if ([3, 6, 12].includes(m)) setMonths(m);
  }, [searchParams]);

  const filtered = clientLinks.filter((c) =>
    c.client_name.toLowerCase().includes(search.toLowerCase())
  );

  async function startDiscovery() {
    if (!selected) return;
    setStarting(true);

    const res = await fetch("/api/rules/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_link_id: selected.id, months }),
    });

    if (!res.ok) {
      const { error } = await res.json();
      alert(`Failed to start discovery: ${error}`);
      setStarting(false);
      return;
    }

    const { job_id } = await res.json();
    router.push(`/rules/${job_id}/review`);
  }

  return (
    <div>
      {fromReclassId && (
        <div className="rounded-xl p-4 mb-6 bg-teal-lighter border border-teal/30">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="text-teal flex-shrink-0 mt-0.5" size={18} />
            <div className="flex-1">
              <div className="font-semibold text-sm text-navy mb-0.5">
                Continuing from Transaction Reclassification
              </div>
              <p className="text-xs text-ink-slate">
                Transactions you just categorized will help us create smarter rules. Vendors that
                consistently matched the same account will show as high-confidence suggestions,
                saving you review time.
              </p>
            </div>
          </div>
        </div>
      )}

      {recentJobs.length > 0 && (
        <details className="rounded-xl bg-white border border-gray-200 mb-6 group">
          <summary className="px-5 py-3 border-b border-gray-200 cursor-pointer list-none flex items-center justify-between">
            <h3 className="font-bold text-sm text-navy">View past discoveries</h3>
            <span className="text-xs text-ink-slate group-open:hidden">Show</span>
            <span className="text-xs text-ink-slate hidden group-open:inline">Hide</span>
          </summary>
          <div className="divide-y divide-gray-100">
            {recentJobs.map((job) => (
              <Link
                key={job.id}
                href={`/rules/${job.id}/review`}
                className="flex items-center px-5 py-3 hover:bg-teal-lighter transition-colors"
              >
                <div className="flex-1">
                  <div className="font-semibold text-sm text-navy">
                    {job.client_links?.client_name || "Unknown"}
                  </div>
                  <div className="text-xs text-ink-slate flex items-center gap-2 mt-0.5">
                    <Clock size={11} /> {new Date(job.created_at).toLocaleDateString()}
                    {job.rules_suggested > 0 && (
                      <span>· {job.rules_suggested} rules suggested</span>
                    )}
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded text-xs font-semibold bg-teal-light text-teal capitalize">
                  {job.status.replace("_", " ")}
                </span>
              </Link>
            ))}
          </div>
        </details>
      )}

      <div className="rounded-xl bg-white border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200">
          <h3 className="font-bold text-base text-navy">Select Client</h3>
          <p className="text-xs text-ink-slate">Choose a client with a connected QBO account</p>
        </div>
        <div className="p-5">
          {selected ? (
            // Once a client is chosen (incl. carried over from a prior step),
            // show it plainly instead of an unselected-looking long list.
            <div className="flex items-center gap-3 rounded-lg bg-teal-lighter border-2 border-teal px-3 py-2.5">
              <div className="rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 bg-teal-light text-teal">
                {selected.client_name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-navy">{selected.client_name}</div>
                <div className="text-xs text-ink-slate flex items-center gap-1">
                  <MapPin size={11} /> {selected.jurisdiction} {selected.state_province}
                </div>
              </div>
              <CheckCircle2 size={18} className="text-teal flex-shrink-0" />
              <button
                onClick={() => setSelected(null)}
                className="text-xs font-semibold text-teal hover:text-teal-dark whitespace-nowrap"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="relative mb-3">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
                <input
                  type="text"
                  placeholder="Search clients..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
                />
              </div>

              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {filtered.map((client) => (
                  <button
                    key={client.id}
                    onClick={() => setSelected(client)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors border-2 border-gray-100 hover:bg-teal-lighter"
                  >
                    <div className="rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 bg-teal-light text-teal">
                      {client.client_name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-navy">{client.client_name}</div>
                      <div className="text-xs text-ink-slate flex items-center gap-1">
                        <MapPin size={11} /> {client.jurisdiction} {client.state_province}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl bg-white border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200">
          <h3 className="font-bold text-base text-navy">How Many Months to Analyze?</h3>
          <p className="text-xs text-ink-slate">
            More history = smarter rules. 6 months is standard. Use 3 for fast results, 12 for very
            mature accounts.
          </p>
        </div>
        <div className="p-5 grid grid-cols-3 gap-3">
          {[3, 6, 12].map((m) => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className={`px-4 py-3 rounded-lg text-sm font-semibold transition-colors ${
                months === m
                  ? "bg-teal text-white border-2 border-teal"
                  : "bg-white text-navy border-2 border-gray-100 hover:border-teal"
              }`}
            >
              {m} months
            </button>
          ))}
        </div>
      </div>

      <RedoWarning clientId={selected?.id ?? null} kind="rules" onAllowChange={setRedoAllowed} />

      <div className="flex justify-end">
        <button
          onClick={startDiscovery}
          disabled={!selected || starting || !redoAllowed}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
        >
          {starting ? <Loader2 className="animate-spin" size={16} /> : <Zap size={16} />}
          {starting ? "Starting discovery..." : "Start Discovery"}
        </button>
      </div>
    </div>
  );
}
