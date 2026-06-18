"use client";

import { useEffect, useState } from "react";
import {
  Video, ExternalLink, Loader2, CheckSquare, Square, ChevronDown, ChevronRight,
  CircleUser, Building2,
} from "lucide-react";

export interface ActionItem {
  id: string;
  recording_id: string;
  index: number;
  text: string;
  status: string | null;
  completed: boolean;
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
 * Cross-component sync: when a to-do is toggled anywhere (the Overview
 * panel or inside a call card), broadcast it so every mounted view of
 * that same item updates its checkbox without a refetch.
 */
export const TODO_EVENT = "grain-todo-toggled";
export type TodoToggle = { recording_id: string; index: number; completed: boolean };
export function broadcastToggle(detail: TodoToggle) {
  window.dispatchEvent(new CustomEvent(TODO_EVENT, { detail }));
}

/** POST the completion change; returns true on success. */
export async function persistToggle(clientLinkId: string, t: TodoToggle): Promise<boolean> {
  try {
    const res = await fetch(`/api/clients/${clientLinkId}/grain/todo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Tiny markdown renderer for Grain's AI summary: handles `## `/`### `
 * headings, `- `/`* ` bullets, and blank-line-separated paragraphs.
 * Inline `**bold**` is honored; everything else renders as plain text.
 */
function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split("\n");
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];

  const flushPara = (key: string) => {
    if (para.length === 0) return;
    blocks.push(
      <p key={key} className="text-sm text-ink-slate leading-relaxed">
        {inline(para.join(" "))}
      </p>
    );
    para = [];
  };
  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={key} className="list-disc pl-5 space-y-1">
        {bullets.map((b, i) => (
          <li key={i} className="text-sm text-ink-slate leading-relaxed">{inline(b)}</li>
        ))}
      </ul>
    );
    bullets = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { flushPara(`p${i}`); flushBullets(`b${i}`); return; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(`p${i}`); flushBullets(`b${i}`);
      blocks.push(
        <div key={`h${i}`} className="text-xs font-bold text-navy mt-2 first:mt-0">
          {inline(heading[2])}
        </div>
      );
      return;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) { flushPara(`p${i}`); bullets.push(bullet[1]); return; }
    flushBullets(`b${i}`);
    para.push(line);
  });
  flushPara("p-last"); flushBullets("b-last");
  return <div className="space-y-2">{blocks}</div>;
}

/** Render inline **bold** spans within a markdown line. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**")
      ? <strong key={i} className="font-semibold text-navy">{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>
  );
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

  // Reflect toggles made elsewhere (e.g. the Overview panel) so the call
  // cards' checkboxes + action-item counts stay in sync without a refetch.
  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent<TodoToggle>).detail;
      if (!d) return;
      setRecordings((prev) =>
        prev.map((rec) => {
          if (rec.id !== d.recording_id) return rec;
          const fix = (arr: ActionItem[]) =>
            arr.map((it) => (it.index === d.index ? { ...it, completed: d.completed } : it));
          return {
            ...rec,
            todos: {
              client: fix(rec.todos.client),
              bookkeeper: fix(rec.todos.bookkeeper),
              unassigned: fix(rec.todos.unassigned),
            },
          };
        })
      );
    };
    window.addEventListener(TODO_EVENT, onToggle);
    return () => window.removeEventListener(TODO_EVENT, onToggle);
  }, []);

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
            <RecordingCard key={rec.id} rec={rec} clientLinkId={clientLinkId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RecordingCard({ rec, clientLinkId }: { rec: Recording; clientLinkId: string }) {
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
              {renderMarkdown(rec.summary)}
            </div>
          )}

          {todoCount > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TodoColumn
                icon={<CircleUser size={12} />}
                label="Client to-dos"
                tone="text-blue-700"
                items={[...rec.todos.client, ...rec.todos.unassigned]}
                clientLinkId={clientLinkId}
              />
              <TodoColumn
                icon={<Building2 size={12} />}
                label="Ironbooks to-dos"
                tone="text-teal"
                items={rec.todos.bookkeeper}
                clientLinkId={clientLinkId}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function TodoColumn({
  icon, label, tone, items, clientLinkId,
}: {
  icon: React.ReactNode; label: string; tone: string; items: ActionItem[]; clientLinkId: string;
}) {
  const openCount = items.filter((it) => !it.completed).length;
  return (
    <div>
      <div className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1 ${tone}`}>
        {icon} {label} <span className="text-ink-light">({openCount})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-ink-light italic">None</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <TodoItem key={it.id} it={it} clientLinkId={clientLinkId} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A single checkable action item. Optimistically flips, persists via the
 * toggle API, and broadcasts so the same item crosses off in the Overview
 * panel (and vice-versa). Reverts on failure.
 */
function TodoItem({ it, clientLinkId }: { it: ActionItem; clientLinkId: string }) {
  const [done, setDone] = useState(it.completed);
  const [busy, setBusy] = useState(false);

  // Stay in sync if the same item is toggled in another view.
  useEffect(() => { setDone(it.completed); }, [it.completed]);
  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent<TodoToggle>).detail;
      if (d && d.recording_id === it.recording_id && d.index === it.index) setDone(d.completed);
    };
    window.addEventListener(TODO_EVENT, onToggle);
    return () => window.removeEventListener(TODO_EVENT, onToggle);
  }, [it.recording_id, it.index]);

  async function toggle() {
    if (busy) return;
    const next = !done;
    setDone(next);
    setBusy(true);
    const ok = await persistToggle(clientLinkId, {
      recording_id: it.recording_id, index: it.index, completed: next,
    });
    setBusy(false);
    if (!ok) { setDone(!next); return; }
    broadcastToggle({ recording_id: it.recording_id, index: it.index, completed: next });
  }

  return (
    <li>
      <div className="flex items-start gap-1.5 text-xs text-navy">
        <button
          onClick={toggle}
          disabled={busy}
          className="flex-shrink-0 mt-0.5 disabled:opacity-50"
          aria-label={done ? "Mark incomplete" : "Mark complete"}
        >
          {done
            ? <CheckSquare size={13} className="text-emerald-600" />
            : <Square size={13} className="text-ink-light hover:text-teal" />}
        </button>
        <span className={done ? "line-through text-ink-light" : ""}>
          {it.transcriptUrl ? (
            <a href={it.transcriptUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {it.text}
            </a>
          ) : it.text}
          {it.assigneeName && <span className="text-ink-light"> · {it.assigneeName}</span>}
          {it.dueDate && <span className="text-amber-700"> · due {it.dueDate}</span>}
        </span>
      </div>
    </li>
  );
}
