"use client";

import { useEffect, useState } from "react";
import {
  Video, ExternalLink, Loader2, CheckSquare, Square, ChevronDown, ChevronRight,
  CircleUser, Building2,
} from "lucide-react";

interface ActionItem {
  text: string;
  status: string | null;
  dueDate: string | null;
  assigneeName: string | null;
  transcriptUrl: string | null;
}
interface Recording {
  id: string;
  title: string;
  url: string | null;
  start_datetime: string | null;
  duration: string | null;
  host: { name: string | null; email: string | null } | null;
  summary: string | null;
  participants: { name: string | null; email: string | null }[];
  todos: { client: ActionItem[]; bookkeeper: ActionItem[]; unassigned: ActionItem[] };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/**
 * Grain recordings for this client — Ironbooks-hosted calls only, with the
 * AI summary and action items split into client vs bookkeeper to-dos.
 * Lazy-fetches on mount (the parent only renders it on the Profile tab).
 */
export function GrainSection({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/clients/${clientLinkId}/grain`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setConfigured(data.configured !== false);
        setRecordings(data.recordings || []);
      } catch (e: any) {
        if (!cancelled) setError(e.message || "Failed to load Grain recordings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientLinkId]);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Video size={15} className="text-teal" />
        <h3 className="text-sm font-bold text-navy">Call recordings</h3>
        <span className="text-[11px] text-ink-light">Ironbooks-hosted calls · from Grain</span>
        {!loading && recordings.length > 0 && (
          <span className="ml-auto text-[11px] font-semibold text-ink-slate bg-slate-100 rounded-full px-2 py-0.5">
            {recordings.length}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-ink-slate py-6 justify-center">
          <Loader2 size={16} className="animate-spin text-teal" /> Loading recordings…
        </div>
      ) : !configured ? (
        <p className="text-xs text-ink-slate italic">
          Grain isn't connected yet. Set <code className="text-[11px]">GRAIN_API_TOKEN</code> to pull
          this client's call recordings, summaries, and action items here.
        </p>
      ) : error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : recordings.length === 0 ? (
        <p className="text-xs text-ink-slate italic">
          No Ironbooks-hosted Grain calls found for this client yet (matched by email or name).
        </p>
      ) : (
        <ul className="space-y-3">
          {recordings.map((rec) => (
            <RecordingCard key={rec.id} rec={rec} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RecordingCard({ rec }: { rec: Recording }) {
  const [open, setOpen] = useState(false);
  const todoCount =
    rec.todos.client.length + rec.todos.bookkeeper.length + rec.todos.unassigned.length;

  return (
    <li className="rounded-xl border border-slate-200 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        {open ? <ChevronDown size={15} className="mt-0.5 text-ink-light flex-shrink-0" /> : <ChevronRight size={15} className="mt-0.5 text-ink-light flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm text-navy truncate">{rec.title}</div>
          <div className="text-[11px] text-ink-slate mt-0.5 flex flex-wrap items-center gap-x-2">
            <span>{fmtDate(rec.start_datetime)}</span>
            {rec.duration && <span>· {rec.duration}</span>}
            {rec.host?.name && <span>· Host: {rec.host.name}</span>}
            {todoCount > 0 && <span className="text-teal font-semibold">· {todoCount} action item{todoCount === 1 ? "" : "s"}</span>}
          </div>
        </div>
        {rec.url && (
          <a
            href={rec.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-teal hover:underline mt-0.5"
          >
            Watch <ExternalLink size={11} />
          </a>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-slate-100">
          {rec.summary && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-1">Summary</div>
              <p className="text-sm text-ink-slate leading-relaxed whitespace-pre-wrap">{rec.summary}</p>
            </div>
          )}

          {todoCount > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TodoColumn
                icon={<CircleUser size={12} />}
                label="Client to-dos"
                tone="text-blue-700"
                items={[...rec.todos.client, ...rec.todos.unassigned]}
              />
              <TodoColumn
                icon={<Building2 size={12} />}
                label="Ironbooks to-dos"
                tone="text-teal"
                items={rec.todos.bookkeeper}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function TodoColumn({
  icon, label, tone, items,
}: {
  icon: React.ReactNode; label: string; tone: string; items: ActionItem[];
}) {
  return (
    <div>
      <div className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1 ${tone}`}>
        {icon} {label} <span className="text-ink-light">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-ink-light italic">None</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it, i) => {
            const done = it.status === "completed";
            const body = (
              <span className="flex items-start gap-1.5 text-xs text-navy">
                {done ? <CheckSquare size={13} className="text-emerald-600 flex-shrink-0 mt-0.5" /> : <Square size={13} className="text-ink-light flex-shrink-0 mt-0.5" />}
                <span className={done ? "line-through text-ink-light" : ""}>
                  {it.text}
                  {it.assigneeName && <span className="text-ink-light"> · {it.assigneeName}</span>}
                  {it.dueDate && <span className="text-amber-700"> · due {it.dueDate}</span>}
                </span>
              </span>
            );
            return (
              <li key={i}>
                {it.transcriptUrl ? (
                  <a href={it.transcriptUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                    {body}
                  </a>
                ) : body}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
