"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Search, Loader2, Check } from "lucide-react";

/**
 * QuickBooks-style client switcher for the profile top bar. Click the current
 * client name → a searchable dropdown of every active client; pick one to jump
 * straight to their profile. The list is fetched lazily on first open.
 */
export function ClientSwitcher({
  currentId,
  currentName,
}: {
  currentId: string;
  currentName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<{ id: string; client_name: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    if (clients || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/clients/switcher");
      const j = await res.json();
      if (res.ok) setClients(j.clients || []);
    } catch {
      /* best-effort — an empty list just shows "no clients" */
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      load();
      setTimeout(() => inputRef.current?.focus(), 30);
    } else {
      setQ("");
    }
  }

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = (clients || []).filter((c) => c.client_name.toLowerCase().includes(needle));

  function go(id: string) {
    setOpen(false);
    setQ("");
    if (id !== currentId) router.push(`/clients/${id}`);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-2 bg-white border border-gray-200 hover:border-teal/50 rounded-lg pl-3 pr-2 py-1.5 text-sm font-semibold text-navy max-w-[240px]"
        title="Switch client"
      >
        <span className="truncate">{currentName}</span>
        <ChevronsUpDown size={14} className="text-ink-slate shrink-0" />
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
            <div className="p-2 border-b border-gray-100">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-light" />
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && filtered.length > 0) go(filtered[0].id);
                  }}
                  placeholder="Switch client…"
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-teal outline-none"
                />
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto py-1">
              {loading ? (
                <div className="px-3 py-4 text-xs text-ink-slate flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin" /> Loading clients…
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-4 text-xs text-ink-light text-center">
                  {clients && clients.length > 0 ? `No clients match “${q}”.` : "No clients found."}
                </div>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => go(c.id)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-teal/5 ${
                      c.id === currentId ? "text-teal-dark font-semibold bg-teal/5" : "text-navy"
                    }`}
                  >
                    <span className="truncate flex-1">{c.client_name}</span>
                    {c.id === currentId && <Check size={13} className="text-teal shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
