"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ChevronDown } from "lucide-react";
import { ClientCard } from "./client-card";
import { ClientPanel } from "./client-panel";
import type { KanbanCard, KanbanBookkeeper, OnboardingStage } from "./types";

const COLUMNS: { key: OnboardingStage; label: string; color: string }[] = [
  { key: "needs_cleanup",       label: "Needs Cleanup",       color: "#64748B" },
  { key: "coa_in_progress",     label: "COA In Progress",     color: "#F59E0B" },
  { key: "reclass_in_progress", label: "Reclass In Progress", color: "#3B82F6" },
  { key: "review",              label: "Review",              color: "#8B5CF6" },
  { key: "awaiting_stripe",     label: "Awaiting Stripe",     color: "#F97316" },
];

interface Props {
  bookkeepers: KanbanBookkeeper[];
  bookkeeperFilter: string;
  canEdit: boolean;
}

export function OnboardingBoard({ bookkeepers, bookkeeperFilter, canEdit }: Props) {
  const [columns, setColumns] = useState<Record<string, { cards: KanbanCard[]; total: number }>>({});
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<{ card: KanbanCard; stage: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [pages, setPages] = useState<Record<string, number>>({});

  const fetchData = useCallback(async (page = 0, append = false) => {
    if (!append) setLoading(true);
    setApiError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (bookkeeperFilter) params.set("bookkeeper_id", bookkeeperFilter);
      const res = await fetch(`/api/kanban/onboarding?${params}`);
      const data = await res.json();
      if (!res.ok) { setApiError(data.error || `HTTP ${res.status}`); setLoading(false); return; }
      if (append) {
        setColumns((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(data.columns)) {
            next[key] = {
              cards: [...(prev[key]?.cards || []), ...(data.columns[key]?.cards || [])],
              total: data.columns[key]?.total ?? prev[key]?.total ?? 0,
            };
          }
          return next;
        });
      } else {
        setColumns(data.columns || {});
        setPages({});
      }
    } finally {
      setLoading(false);
    }
  }, [bookkeeperFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function loadMore(key: string) {
    const nextPage = (pages[key] || 0) + 1;
    setLoadingMore(key);
    setPages((p) => ({ ...p, [key]: nextPage }));
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: "20" });
      if (bookkeeperFilter) params.set("bookkeeper_id", bookkeeperFilter);
      const res = await fetch(`/api/kanban/onboarding?${params}`);
      const data = await res.json();
      setColumns((prev) => ({
        ...prev,
        [key]: {
          cards: [...(prev[key]?.cards || []), ...(data.columns[key]?.cards || [])],
          total: data.columns[key]?.total ?? prev[key]?.total ?? 0,
        },
      }));
    } finally {
      setLoadingMore(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-teal" size={28} />
      </div>
    );
  }

  if (apiError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-sm text-red-800">
        <strong>API error:</strong> {apiError}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs text-ink-slate">
          {Object.values(columns).reduce((s, c) => s + (c.total || 0), 0)} clients in onboarding
        </div>
        <button
          onClick={() => fetchData()}
          className="flex items-center gap-1.5 text-xs text-ink-slate hover:text-navy"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-260px)]">
        {COLUMNS.map(({ key, label, color }) => {
          const col = columns[key] || { cards: [], total: 0 };
          const hasMore = col.cards.length < col.total;

          return (
            <div key={key} className="flex-shrink-0 w-72 flex flex-col">
              {/* Column header */}
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                <span className="text-xs font-bold text-navy uppercase tracking-wider">{label}</span>
                <span className="ml-auto text-xs font-semibold text-ink-slate bg-gray-100 px-1.5 py-0.5 rounded-full">
                  {col.total}
                </span>
              </div>

              {/* Cards */}
              <div className="flex-1 space-y-2.5">
                {col.cards.length === 0 ? (
                  <div className="rounded-xl border-2 border-dashed border-gray-100 p-6 text-center">
                    <p className="text-xs text-ink-light">No clients here</p>
                  </div>
                ) : (
                  col.cards.map((card) => (
                    <ClientCard
                      key={card.id}
                      card={card}
                      stage={key}
                      onOpen={(c) => setOpenCard({ card: c, stage: key })}
                      onRefresh={() => fetchData()}
                      canEdit={canEdit}
                    />
                  ))
                )}

                {hasMore && (
                  <button
                    onClick={() => loadMore(key)}
                    disabled={loadingMore === key}
                    className="w-full py-2 text-xs text-ink-slate hover:text-navy flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {loadingMore === key
                      ? <Loader2 size={12} className="animate-spin" />
                      : <ChevronDown size={12} />}
                    {loadingMore === key ? "Loading…" : `Load more (${col.total - col.cards.length} remaining)`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {openCard && (
        <ClientPanel
          card={openCard.card}
          stage={openCard.stage}
          bookkeepers={bookkeepers}
          canEdit={canEdit}
          onClose={() => setOpenCard(null)}
          onRefresh={() => fetchData()}
        />
      )}
    </>
  );
}
