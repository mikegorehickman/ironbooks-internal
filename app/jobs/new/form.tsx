"use client";

import { useState, useEffect } from "react";
import { RedoWarning } from "@/components/RedoWarning";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import {
  Search, ArrowRight, MapPin, CheckCircle2, Plus, Loader2, Globe2, Briefcase, Sparkles, Calendar,
} from "lucide-react";
import type { Database } from "@/lib/database.types";
import { CANADIAN_PROVINCES, getProvinceTax } from "@/lib/canadian-tax";
import { INDUSTRIES, getIndustry, suggestIndustryFromName, type IndustryKey } from "@/lib/industries";
import { CleanupSections } from "./cleanup-sections";
import type { RosterClient } from "@/lib/cleanup-roster";

type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

export function NewJobForm({
  clientLinks,
  sections,
}: {
  clientLinks: ClientLink[];
  sections?: {
    continueCleanup: RosterClient[];
    completed: RosterClient[];
    stripeRecon: RosterClient[];
    bsCleanup: RosterClient[];
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ClientLink | null>(null);
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState<"client" | "jurisdiction">("client");

  // Editable jurisdiction state (initialized from client_link when selected)
  const [country, setCountry] = useState<"US" | "CA">("US");
  const [province, setProvince] = useState<string>("");
  const [industry, setIndustry] = useState<IndustryKey>("painters");
  const [aiSuggestedIndustry, setAiSuggestedIndustry] = useState<IndustryKey | null>(null);

  // Date range that scopes the cleanup. Renames + creates happen regardless;
  // merges + inactivation-empty-checks honor this window. Default to "This
  // Calendar Year" since that's the typical bookkeeper instinct ("clean up
  // 2026 right now, leave 2025 books alone").
  interface DateRangePreset {
    id: string;
    label: string;
    start: string;
    end: string;
  }
  const [datePresetId, setDatePresetId] = useState<string>("cy");
  const [datePresets, setDatePresets] = useState<DateRangePreset[]>([]);
  const [fiscalYearStartMonthName, setFiscalYearStartMonthName] = useState<string>("");
  const [loadingPresets, setLoadingPresets] = useState(false);
  const selectedPreset = datePresets.find((p) => p.id === datePresetId);

  // Deep-links (?client=) must resolve against EVERY roster bucket, not just
  // "new cleanup". A client with a completed cleanup lives in
  // sections.completed — the profile "Re-run COA Cleanup" button and the
  // stepper's Step-1 link both target exactly those clients, and before this
  // the lookup silently missed and dumped the user on a picker that couldn't
  // even show them (Dominion Painters, 2026-07-11).
  const allSelectable: ClientLink[] = [
    ...clientLinks,
    ...([
      ...(sections?.continueCleanup ?? []),
      ...(sections?.completed ?? []),
      ...(sections?.stripeRecon ?? []),
      ...(sections?.bsCleanup ?? []),
    ] as unknown as ClientLink[]),
  ].filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);

  useEffect(() => {
    const clientId = searchParams.get("client");
    if (clientId && !selected) {
      const found = allSelectable.find((c) => c.id === clientId);
      if (found) {
        setSelected(found);
        setCountry((found.jurisdiction as "US" | "CA") || "US");
        setProvince(found.state_province || "");
        // Use stored industry if set; otherwise AI-suggest from name
        const stored = (found as any).industry as IndustryKey | null;
        const suggested = suggestIndustryFromName(found.client_name);
        setIndustry(stored || suggested || "painters");
        setAiSuggestedIndustry(suggested);
        setStep("jurisdiction");
      }
    }
  }, [searchParams, clientLinks, sections]);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // Fetch date presets from QBO's company info (fiscal-year-aware) when a
  // client is picked. Reuses the same /company-info endpoint the reclass
  // workflow already uses; that endpoint computes "this fiscal year",
  // "this + last fiscal year", etc. via getReclassDateRangePresets.
  useEffect(() => {
    if (!selected) return;
    setLoadingPresets(true);
    fetch(`/api/clients/${selected.id}/company-info`)
      .then((r) => (r.ok ? r.json() : Promise.reject("Could not load fiscal year")))
      .then((data: any) => {
        // The endpoint returns date_range_presets (snake_case) and
        // company.fiscal_year_start_month_name. Earlier I wrote this against
        // an assumed camelCase shape, which made datePresets state become
        // undefined and crashed with "Cannot read properties of undefined
        // (reading 'find')" once the bookkeeper picked a date preset.
        const presets: DateRangePreset[] = Array.isArray(data?.date_range_presets)
          ? data.date_range_presets
          : Array.isArray(data?.datePresets) // legacy fallback in case the API ever changes
          ? data.datePresets
          : [];
        const fyMonth: string =
          data?.company?.fiscal_year_start_month_name ||
          data?.fiscalYearStartMonthName ||
          "January";
        setDatePresets(presets);
        setFiscalYearStartMonthName(fyMonth);
      })
      .catch(() => {
        // Sensible fallback if the fetch fails — calendar-year only
        const y = new Date().getUTCFullYear();
        const today = new Date().toISOString().slice(0, 10);
        setDatePresets([
          { id: "cy", label: "This Calendar Year", start: `${y}-01-01`, end: today },
          { id: "cy_plus_1", label: "This + Last Calendar Year", start: `${y - 1}-01-01`, end: today },
        ]);
      })
      .finally(() => setLoadingPresets(false));
  }, [selected]);

  // Default list stays "no cleanup started yet"; an actual search sweeps every
  // bucket so an already-cleaned client (e.g. for a re-run) is findable by name.
  const filtered = (search.trim() ? allSelectable : clientLinks).filter((c) =>
    c.client_name.toLowerCase().includes(search.toLowerCase())
  );

  function pickClient(c: ClientLink) {
    setSelected(c);
    setCountry((c.jurisdiction as "US" | "CA") || "US");
    setProvince(c.state_province || "");
    const stored = (c as any).industry as IndustryKey | null;
    const suggested = suggestIndustryFromName(c.client_name);
    setIndustry(stored || suggested || "painters");
    setAiSuggestedIndustry(suggested);
    setStep("jurisdiction");
  }

  const provinceTax = getProvinceTax(province);
  const needsProvince = country === "CA";
  const [redoAllowed, setRedoAllowed] = useState(true);
  const canStart = !!selected && (!needsProvince || !!province);

  async function startJob() {
    if (!selected || !canStart) return;
    setCreating(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      alert("Not signed in");
      setCreating(false);
      return;
    }

    // SAME-CLIENT GUARD — refuse to start a second cleanup on a client that
    // already has one in flight. Different clients in parallel is fine and
    // encouraged; same-client parallel cleanups cause snapshot races and
    // "account no longer exists" errors mid-rename. Point the bookkeeper at
    // the existing job so they can stop or finish it first.
    const ACTIVE_STATUSES = ["draft", "in_review", "pending_lisa", "approved", "executing"];
    const { data: existingJobs } = await supabase
      .from("coa_jobs")
      .select("id, status")
      .eq("client_link_id", selected.id)
      .in("status", ACTIVE_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1);
    if (existingJobs && existingJobs.length > 0) {
      const existing = existingJobs[0];
      const proceed = confirm(
        `${selected.client_name} already has an active cleanup (status: ${existing.status}). ` +
        `Running two at once on the same client causes snapshot races. ` +
        `\n\nOpen the existing job?`
      );
      setCreating(false);
      if (proceed) router.push(`/jobs/${existing.id}/review`);
      return;
    }

    const jurisdictionChanged = selected.jurisdiction !== country;
    const provinceChanged = (selected.state_province || "") !== province;
    const industryChanged = ((selected as any).industry || "painters") !== industry;
    if (jurisdictionChanged || provinceChanged || industryChanged) {
      const { error: clientErr } = await supabase
        .from("client_links")
        .update({
          jurisdiction: country,
          state_province: province || null,
          industry,
        } as any)
        .eq("id", selected.id);
      if (clientErr) {
        alert(`Could not update client: ${clientErr.message}`);
        setCreating(false);
        return;
      }
    }

    if (!selectedPreset) {
      alert("Pick a date range before starting the cleanup.");
      setCreating(false);
      return;
    }

    const { data, error } = await supabase
      .from("coa_jobs")
      .insert({
        client_link_id: selected.id,
        bookkeeper_id: user.id,
        status: "draft",
        date_range_start: selectedPreset.start,
        date_range_end: selectedPreset.end,
        date_range_preset: selectedPreset.id,
      } as any)
      .select()
      .single();

    if (error || !data) {
      alert(`Error creating job: ${error?.message}`);
      setCreating(false);
      return;
    }

    fetch(`/api/jobs/${data.id}/analyze`, { method: "POST" }).catch((e) =>
      console.error("Analysis kickoff failed:", e)
    );

    router.push(`/jobs/${data.id}/review`);
  }

  // ─────────── Step 1: client picker ───────────
  if (step === "client") {
    return (
      <div>
        {clientLinks.length === 0 && (
          <div className="rounded-xl p-6 mb-6 bg-yellow-50 border border-yellow-200">
            <h3 className="font-bold text-sm mb-2 text-navy">No clients connected yet</h3>
            <p className="text-sm text-ink-slate mb-4">
              Before you can run a cleanup, you need to connect a QuickBooks Online client.
            </p>
            <a
              href="/api/qbo/connect"
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <Plus size={16} />
              Connect QuickBooks Client
            </a>
          </div>
        )}

        <StepIndicator current="client" />

        <div className="rounded-xl bg-white border border-gray-200 mb-5">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="font-bold text-base text-navy">New cleanup</h3>
            <p className="text-xs text-ink-slate">Connected clients with no cleanup started yet</p>
          </div>

          <div className="p-5">
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

            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {filtered.length === 0 && search === "" && (
                <p className="text-sm text-ink-slate py-4 text-center">No clients waiting to start — check the sections below.</p>
              )}
              {filtered.map((client) => (
                <button
                  key={client.id}
                  onClick={() => pickClient(client)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left border-2 border-gray-100 hover:bg-teal-lighter hover:border-teal transition-colors"
                >
                  <div className="rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 bg-teal-light text-teal">
                    {client.client_name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-navy">{client.client_name}</div>
                    <div className="text-xs flex items-center gap-2 text-ink-slate">
                      <MapPin size={11} /> {client.jurisdiction} {client.state_province && `· ${client.state_province}`}
                    </div>
                  </div>
                  <ArrowRight size={16} className="text-ink-light" />
                </button>
              ))}
              {filtered.length === 0 && search !== "" && (
                <p className="text-sm text-ink-slate py-4 text-center">No clients match your search.</p>
              )}
            </div>
          </div>
        </div>

        {sections && (
          <CleanupSections
            continueCleanup={sections.continueCleanup}
            completed={sections.completed}
            stripeRecon={sections.stripeRecon}
            bsCleanup={sections.bsCleanup}
          />
        )}
      </div>
    );
  }

  // ─────────── Step 2: country & province ───────────
  return (
    <div>
      <StepIndicator current="jurisdiction" />

      <div className="rounded-xl bg-white border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-base text-navy">Client setup</h3>
            <p className="text-xs text-ink-slate">
              Country, province, and industry — drives COA template and tax codes
            </p>
          </div>
          <button
            onClick={() => setStep("client")}
            className="text-xs font-semibold text-ink-slate hover:text-navy"
          >
            ← Change client
          </button>
        </div>

        <div className="p-5 space-y-5">
          {selected && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-teal-lighter border border-teal/30">
              <div className="rounded-md flex items-center justify-center font-bold text-xs w-9 h-9 bg-white text-teal border border-teal/30">
                {selected.client_name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-navy">{selected.client_name}</div>
                <div className="text-xs text-ink-slate">Selected client</div>
              </div>
              <CheckCircle2 size={18} className="text-teal" />
            </div>
          )}

          {/* Industry picker */}
          <div>
            <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-1">
              <Briefcase size={14} /> Industry (for COA template)
            </label>
            <p className="text-xs text-ink-slate mb-2">Selects the master chart of accounts template.</p>
            {aiSuggestedIndustry && (
              <div className="text-xs text-ink-slate mb-2 flex items-center gap-1.5">
                <Sparkles size={11} className="text-teal" />
                AI suggested <span className="font-semibold text-navy">{getIndustry(aiSuggestedIndustry)?.label}</span>
                {" "}based on the client name. Change if needed.
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {INDUSTRIES.map((ind) => {
                const isSelected = industry === ind.key;
                const isAiPick = aiSuggestedIndustry === ind.key;
                return (
                  <button
                    key={ind.key}
                    onClick={() => setIndustry(ind.key)}
                    className={`relative p-3 rounded-lg border-2 text-left transition-colors ${
                      isSelected
                        ? "bg-teal-lighter border-teal text-teal"
                        : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                    }`}
                  >
                    {isAiPick && !isSelected && (
                      <span className="absolute -top-1 -right-1 text-[9px] font-bold bg-teal text-white px-1.5 py-0.5 rounded-full">
                        AI pick
                      </span>
                    )}
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-base">{ind.emoji}</span>
                      <span className="font-semibold text-xs">{ind.label}</span>
                    </div>
                    <div className="text-[10px] leading-tight text-ink-light">{ind.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-2">
              <Globe2 size={14} /> Country
            </label>
            <div className="grid grid-cols-2 gap-3">
              {(["US", "CA"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setCountry(c);
                    if (c === "US") setProvince("");
                  }}
                  className={`px-4 py-3 rounded-lg border-2 text-sm font-semibold transition-colors ${
                    country === c
                      ? "bg-teal-lighter border-teal text-teal"
                      : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                  }`}
                >
                  {c === "US" ? "United States" : "Canada"}
                </button>
              ))}
            </div>
          </div>

          {country === "CA" && (
            <div>
              <label className="text-sm font-semibold text-navy mb-2 block">
                Province / Territory
              </label>
              <select
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
              >
                <option value="">Select province or territory…</option>
                {CANADIAN_PROVINCES.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name} ({p.display})
                  </option>
                ))}
              </select>

              {provinceTax && (
                <div className="mt-3 p-3 rounded-lg bg-blue-50 border border-blue-100">
                  <div className="text-xs font-bold uppercase tracking-wider text-blue-900 mb-1">
                    Sales Tax — {provinceTax.name}
                  </div>
                  <div className="text-sm font-semibold text-blue-800">{provinceTax.display}</div>
                  <div className="text-xs text-blue-700 mt-1">
                    Combined effective rate: <span className="font-bold">{(provinceTax.combined * 100).toFixed(provinceTax.combined === 0.14975 ? 3 : 0)}%</span>
                  </div>
                  <div className="text-[11px] text-blue-600 mt-2">
                    Tax codes will be applied during reclassification and bank rule generation.
                  </div>
                </div>
              )}
            </div>
          )}

          {country === "US" && (
            <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
              <div className="text-xs text-ink-slate">
                US clients — no transaction-level sales tax applied. Master COA uses the US template.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Cleanup Scope (Date Range) ─── */}
      <div className="rounded-xl bg-white border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200">
          <h3 className="font-bold text-base text-navy flex items-center gap-2">
            <Calendar size={16} className="text-teal" />
            Cleanup Scope
          </h3>
          <p className="text-xs text-ink-slate mt-1">
            Merges and deletions only affect this date range. Renames apply everywhere.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          {loadingPresets ? (
            <div className="flex items-center gap-2 text-sm text-ink-slate">
              <Loader2 className="animate-spin" size={14} />
              Loading fiscal year from QuickBooks...
            </div>
          ) : (
            <>
              {fiscalYearStartMonthName && (
                <div className="text-xs text-ink-slate">
                  Fiscal year starts in <span className="font-semibold">{fiscalYearStartMonthName}</span> (pulled from QBO)
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {datePresets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setDatePresetId(p.id)}
                    className={`px-3 py-2.5 rounded-lg border-2 text-xs font-semibold text-left transition-colors ${
                      datePresetId === p.id
                        ? "bg-teal-lighter border-teal text-teal"
                        : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                    }`}
                  >
                    <div>{p.label}</div>
                    <div className="text-[10px] mt-0.5 text-ink-slate font-mono">
                      {p.start} → {p.end}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <RedoWarning clientId={selected?.id ?? null} kind="coa" onAllowChange={setRedoAllowed} preAcknowledged={searchParams.get("redo") === "1"} />

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => router.push(`/reclass/new?client=${selected!.id}`)}
          className="inline-flex items-center gap-2 text-sm font-semibold text-ink-slate hover:text-navy border border-gray-200 hover:border-gray-300 bg-white px-4 py-2.5 rounded-lg transition-colors"
          title="Use this only if the chart of accounts is already cleaned up. Skips COA review and jumps straight to mapping transactions."
        >
          <ArrowRight size={15} />
          Skip to Reclassification
        </button>
        <button
          onClick={startJob}
          disabled={!canStart || creating || !selectedPreset || !redoAllowed}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
        >
          {creating ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
          {creating ? "Starting..." : "Pull COA & Start Review"}
        </button>
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: "client" | "jurisdiction" }) {
  const steps = [
    { key: "client", label: "Client" },
    { key: "jurisdiction", label: "Setup" },
    { key: "review", label: "Review" },
  ] as const;
  const activeIdx = current === "client" ? 0 : 1;

  return (
    <div className="flex items-center gap-3 mb-6">
      {steps.map((step, idx) => {
        const done = idx < activeIdx;
        const active = idx === activeIdx;
        return (
          <div key={step.key} className="flex items-center gap-3 flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
                  done
                    ? "bg-teal text-white"
                    : active
                    ? "bg-teal/15 text-teal ring-2 ring-teal/30"
                    : "bg-gray-100 text-ink-light"
                }`}
              >
                {done ? <CheckCircle2 size={14} /> : idx + 1}
              </div>
              <span
                className={`text-xs font-semibold truncate ${
                  active ? "text-navy" : done ? "text-teal" : "text-ink-light"
                }`}
              >
                {step.label}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <div className={`h-px flex-1 ${done ? "bg-teal/40" : "bg-gray-200"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
