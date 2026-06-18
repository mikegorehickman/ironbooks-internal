"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ListChecks, Loader2, Square, CircleUser, Building2, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  TODO_EVENT, type TodoToggle, type ActionItem,
  broadcastToggle, persistToggle,
} from "./grain-section";

interface Recording {
  id: string;
  title: string;
  start_datetime: string | null;
  todos: { client: ActionItem[]; bookkeeper: ActionItem[]; unassigned: ActionItem[] };
}

/** An open to-do plus the call it came from, for the aggregated view. */
interface OpenTodo extends ActionItem {
  callTitle: string;
  callDate: string | null;
}

function fmtShort(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Aggregated, checkable to-do list for the Overview tab. Pulls every
 * OPEN action item across all of this client's calls into one place so
 * the manager/bookkeeper can work the list top-down. Checking an item
 * here persists it, removes it from this list, and (via the shared
 * TODO_EVENT) leaves it crossed-off in the nested call card on the
 * Profile tab. Completed items live only in the call cards.
 */
export function CallTodosPanel({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(true);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  // recording_id#index of items completed this session — filtered out of
  // the open list immediately so a checked item slides away.
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/clients/${clientLinkId}/grain`);
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) setRecordings(data.recordings || []);
      } catch {
        /* soft-fail: panel just stays empty */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientLinkId]);

  // If an item is completed elsewhere (call card), drop it here too.
  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent<TodoToggle>).detail;
      if (!d) return;
      const key = `${d.recording_id}#${d.index}`;
      setDoneKeys((prev) => {
        const next = new Set(prev);
        if (d.completed) next.add(key); else next.delete(key);
        return next;
      });
    };
    window.addEventListener(TODO_EVENT, onToggle);
    return () => window.removeEventListener(TODO_EVENT, onToggle);
  }, []);

  const { clientTodos, bkTodos } = useMemo(() => {
    const client: OpenTodo[] = [];
    const bk: OpenTodo[] = [];
    for (const rec of recordings) {
      const ctx = { callTitle: rec.title, callDate: rec.start_datetime };
      for (const it of [...rec.todos.client, ...rec.todos.unassigned]) {
        if (!it.completed && !doneKeys.has(`${it.recording_id}#${it.index}`)) client.push({ ...it, ...ctx });
      }
      for (const it of rec.todos.bookkeeper) {
        if (!it.completed && !doneKeys.has(`${it.recording_id}#${it.index}`)) bk.push({ ...it, ...ctx });
      }
    }
    return { clientTodos: client, bkTodos: bk };
  }, [recordings, doneKeys]);

  const total = clientTodos.length + bkTodos.length;

  // Nothing to show until we know there are open call to-dos.
  if (loading) {
    return (
      <section className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 text-sm text-ink-slate">
          <Loader2 size={15} className="animate-spin text-teal" /> Loading call to-dos…
        </div>
      </section>
    );
  }
  if (total === 0) return null;

  async function check(t: OpenTodo) {
    const key = `${t.recording_id}#${t.index}`;
    setDoneKeys((prev) => new Set(prev).add(key)); // optimistic remove
    const ok = await persistToggle(clientLinkId, {
      recording_id: t.recording_id, index: t.index, completed: true,
    });
    if (!ok) {
      setDoneKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
      return;
    }
    broadcastToggle({ recording_id: t.recording_id, index: t.index, completed: true });
  }

  return (
    <section className="bg-white rounded-2xl border border-gray-100 p-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 mb-1 text-left"
      >
        {open ? <ChevronDown size={15} className="text-ink-light" /> : <ChevronRight size={15} className="text-ink-light" />}
        <ListChecks size={15} className="text-teal" />
        <h2 className="text-base font-bold text-navy">Call to-dos</h2>
        <span className="text-[11px] text-ink-light">from Grain action items</span>
        <span className="ml-auto text-[11px] font-semibold text-ink-slate bg-slate-100 rounded-full px-2 py-0.5">
          {total} open
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
          <TodoGroup
            icon={<CircleUser size={12} />} tone="text-blue-700"
            label="Client to-dos" items={clientTodos} onCheck={check}
          />
          <TodoGroup
            icon={<Building2 size={12} />} tone="text-teal"
            label="Ironbooks to-dos" items={bkTodos} onCheck={check}
          />
        </div>
      )}
    </section>
  );
}

function TodoGroup({
  icon, tone, label, items, onCheck,
}: {
  icon: React.ReactNode; tone: string; label: string;
  items: OpenTodo[]; onCheck: (t: OpenTodo) => void;
}) {
  return (
    <div>
      <div className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1 ${tone}`}>
        {icon} {label} <span className="text-ink-light">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-ink-light italic">All clear</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => onCheck(t)}
                className="w-full flex items-start gap-1.5 text-xs text-navy text-left group"
              >
                <Square size={13} className="text-ink-light group-hover:text-teal flex-shrink-0 mt-0.5" />
                <span>
                  {t.text}
                  {t.dueDate && <span className="text-amber-700"> · due {t.dueDate}</span>}
                  <span className="block text-[10px] text-ink-light mt-0.5">
                    {t.callTitle}{t.callDate ? ` · ${fmtShort(t.callDate)}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
