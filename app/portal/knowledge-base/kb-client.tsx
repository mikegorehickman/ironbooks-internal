"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen, ChevronDown, ChevronRight, Loader2, Search, Sparkles, X,
} from "lucide-react";
import type { KBCategory } from "@/lib/kb-content";

/**
 * Markdown-lite renderer for KB answers + AI responses. Supports **bold**,
 * "- " bullets, "1." numbered lists, and blank-line paragraphs — exactly
 * what the content uses. No HTML injection: everything renders as text.
 */
function MdLite({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className="space-y-2.5 text-sm text-ink-slate leading-relaxed">
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim() !== "");
        if (lines.length === 0) return null;
        const isBullets = lines.every((l) => l.trim().startsWith("- "));
        const isNumbered = lines.every((l) => /^\d+\.\s/.test(l.trim()));
        if (isBullets || isNumbered) {
          const List = isBullets ? "ul" : "ol";
          return (
            <List
              key={bi}
              className={`${isBullets ? "list-disc" : "list-decimal"} pl-5 space-y-1`}
            >
              {lines.map((l, li) => (
                <li key={li}>
                  <Bold text={l.trim().replace(/^(-\s|\d+\.\s)/, "")} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                <Bold text={l} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Bold({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="text-navy font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  );
}

interface AIResult {
  answer: string;
  sources: { id: string; category: string; question: string }[];
}

export function KnowledgeBaseClient({ categories }: { categories: KBCategory[] }) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<AIResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Deep link: /portal/knowledge-base?open=<id> expands + scrolls to a
  // specific answer (e.g. the "What's this?" link beside the DRAFT badge).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (!id) return;
    setOpenItems((prev) => new Set(prev).add(id));
    const t = setTimeout(() => {
      itemRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => clearTimeout(t);
  }, []);

  const totalCount = useMemo(
    () => categories.reduce((s, c) => s + c.items.length, 0),
    [categories]
  );

  async function search() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/portal/kb-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult({ answer: body.answer, sources: body.sources || [] });
      // Auto-expand the cited entries so "read more" is one scroll away
      if (body.sources?.length) {
        setOpenItems((prev) => {
          const next = new Set(prev);
          for (const s of body.sources) next.add(s.id);
          return next;
        });
      }
    } catch (e: any) {
      setError(e?.message || "Search failed — try again.");
    } finally {
      setSearching(false);
    }
  }

  function toggle(id: string) {
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function jumpTo(id: string) {
    setOpenItems((prev) => new Set(prev).add(id));
    // Wait a tick so the accordion expands before scrolling
    setTimeout(() => {
      itemRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }

  return (
    <div className="space-y-6">
      {/* ── AI SEARCH ── */}
      <div className="bg-gradient-to-r from-teal-dark to-teal rounded-2xl p-5 text-white">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={16} />
          <h2 className="font-bold text-sm">Ask the Knowledge Base</h2>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder='e.g. "How much should I set aside for taxes?" or "Why doesn’t my P&L match what I thought?"'
              maxLength={1000}
              className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-white/15 border border-white/25 text-sm text-white placeholder:text-white/55 focus:outline-none focus:bg-white/20"
            />
          </div>
          <button
            onClick={search}
            disabled={searching || !query.trim()}
            className="flex-shrink-0 px-4 py-2.5 rounded-lg bg-white text-teal-dark text-sm font-bold hover:bg-white/90 disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
        <p className="text-[11px] text-white/65 mt-2">
          Answers come from the {totalCount} Q&amp;As below. Question about your own
          numbers? Use Ask the AI; need a person? Message your bookkeeper.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start justify-between gap-2">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">
            <X size={14} />
          </button>
        </div>
      )}

      {/* AI answer */}
      {result && (
        <div className="bg-white border-2 border-teal/30 rounded-2xl overflow-hidden">
          <div className="px-5 py-3 bg-teal/5 border-b border-teal/20 flex items-center justify-between">
            <span className="text-sm font-bold text-teal-dark flex items-center gap-1.5">
              <Sparkles size={13} />
              Answer
            </span>
            <button
              onClick={() => setResult(null)}
              className="text-ink-light hover:text-navy"
              aria-label="Dismiss answer"
            >
              <X size={15} />
            </button>
          </div>
          <div className="px-5 py-4">
            <MdLite text={result.answer} />
            {result.sources.length > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-100">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-slate mb-1.5">
                  From these FAQs
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {result.sources.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => jumpTo(s.id)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-teal/5 border border-teal/25 text-teal-dark hover:bg-teal/10 text-left"
                    >
                      {s.question}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ACCORDION BY CATEGORY ── */}
      <div className="space-y-5">
        {categories.map((cat) => (
          <div key={cat.id}>
            <h3 className="flex items-center gap-2 text-sm font-bold text-navy uppercase tracking-wider mb-2">
              <BookOpen size={13} className="text-teal" />
              {cat.title}
              <span className="font-normal normal-case text-ink-light tracking-normal">
                ({cat.items.length})
              </span>
            </h3>
            <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {cat.items.map((item) => {
                const open = openItems.has(item.id);
                return (
                  <div
                    key={item.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(item.id, el);
                    }}
                  >
                    <button
                      onClick={() => toggle(item.id)}
                      className="w-full flex items-start gap-2.5 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                    >
                      {open ? (
                        <ChevronDown size={15} className="text-teal flex-shrink-0 mt-0.5" />
                      ) : (
                        <ChevronRight size={15} className="text-ink-light flex-shrink-0 mt-0.5" />
                      )}
                      <span className={`text-sm ${open ? "font-semibold text-navy" : "text-navy"}`}>
                        {item.question}
                      </span>
                    </button>
                    {open && (
                      <div className="px-4 pb-4 pl-11">
                        <MdLite text={item.answer} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-ink-light text-center pb-4">
        Questions not answered here? Send us a message in the portal or reach
        out to your bookkeeper directly.
      </p>
    </div>
  );
}
