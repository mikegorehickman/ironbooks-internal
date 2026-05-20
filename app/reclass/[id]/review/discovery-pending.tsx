"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, AlertCircle, CheckCircle2, Search, Sparkles, Database, X, RotateCcw } from "lucide-react";

export function ReclassDiscoveryPending({
  jobId,
  clientLinkId,
  workflow,
}: {
  jobId: string;
  clientLinkId?: string;
  workflow?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string>("starting");
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState<string>("");
  const [elapsed, setElapsed] = useState<number>(0);
  const [webSearchLog, setWebSearchLog] = useState<string[]>([]);
  const [skipping, setSkipping] = useState(false);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/reclass/${jobId}/status`);
        if (!res.ok) throw new Error("Status check failed");
        const data = await res.json();
        if (cancelled) return;

        setStatus(data.status);
        setStats(data.stats);

        if (data.error_message?.startsWith("[web_search]")) {
          setWebSearchLog((prev) => {
            const entry = `${new Date().toLocaleTimeString()} ${data.error_message}`;
            return prev.includes(entry) ? prev : [...prev, entry];
          });
        }

        if (data.status === "in_review") {
          window.location.reload();
          return;
        }
        if (data.status === "failed") {
          setError(data.error_message || "Discovery failed");
          return;
        }
        if (data.status === "complete") {
          window.location.href = `/reclass/${jobId}/execute`;
          return;
        }

        setTimeout(poll, 2000);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    }

    poll();
    return () => { cancelled = true; };
  }, [jobId, router]);

  async function skipWebSearch() {
    setSkipping(true);
    try {
      await fetch(`/api/reclass/${jobId}/skip-web-search`, { method: "POST" });
      setSkipped(true);
    } finally {
      setSkipping(false);
    }
  }

  if (error) {
    // Build a retry URL — drops the bookkeeper into the new-reclass form
    // pre-selected on this client. They pick the source account + dates
    // again (the failed job's source/dates aren't known to be safe to
    // reuse without confirmation, and re-picking takes <10 seconds).
    const retryHref = clientLinkId
      ? `/reclass/new?client=${clientLinkId}${
          workflow ? `&workflow=${encodeURIComponent(workflow)}` : ""
        }`
      : "/reclass/new";

    const isWatchdogFailure = /watchdog/i.test(error);

    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8 space-y-5">
        <div className="flex items-start gap-3 p-4 bg-red-50 text-red-800 rounded-lg">
          <AlertCircle className="flex-shrink-0 mt-0.5" size={20} />
          <div>
            <div className="font-semibold mb-1">Discovery failed</div>
            <div className="text-sm">{error}</div>
            {isWatchdogFailure && (
              <div className="text-xs mt-2 text-red-700/80 leading-relaxed">
                Most often a transient Anthropic / web-search hang. Starting a
                fresh reclass usually succeeds — the AI batches and per-vendor
                web search both have explicit timeouts now, so a single stalled
                call won&apos;t block the whole job again.
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href={retryHref}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            <RotateCcw size={14} />
            Start a fresh reclass for this client
          </Link>
          <Link
            href="/dashboard"
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Back to dashboard
          </Link>
          <a
            href={`/api/jobs/${jobId}/error-report`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-semibold text-ink-slate hover:text-navy underline ml-auto"
            title="Markdown error report — share with engineering if this keeps happening"
          >
            Download error report
          </a>
        </div>
      </div>
    );
  }

  const stage =
    elapsed < 5 ? "pulling"
    : elapsed < 15 ? "knowledge_base"
    : elapsed < 45 ? "ai"
    : "web_search";

  const webSearchActive = stage === "web_search";

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-8">
      <div className="flex items-center gap-3 mb-2">
        <Loader2 className="animate-spin text-teal" size={24} />
        <h2 className="text-lg font-bold text-navy">Discovery in progress</h2>
        <span className="ml-auto text-xs font-mono text-ink-slate">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </span>
      </div>
      <p className="text-sm text-ink-slate mb-6">
        Each transaction goes through a 4-tier categorization pipeline. Most match instantly from
        the knowledge base or your saved bank rules; only the unknowns hit the AI or web search.
      </p>

      {/* Pipeline stages */}
      <div className="rounded-xl bg-gray-50 p-4 mb-5 border border-gray-100">

        {/* Row 1 */}
        <div className="flex items-start gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage !== "pulling" ? "#D1FAE5" : "#E8F2F0" }}>
            {stage !== "pulling"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : <Loader2 size={14} className="text-teal animate-spin" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage !== "pulling" ? "text-green-700" : "text-navy"}`}>
              1. Pull transactions from QuickBooks
            </div>
            <div className="text-xs text-ink-slate mt-0.5">Fetching all lines in the selected date range</div>
          </div>
        </div>

        {/* Row 2 */}
        <div className="flex items-start gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage !== "pulling" && stage !== "knowledge_base" ? "#D1FAE5" : stage === "knowledge_base" ? "#E8F2F0" : "#F3F4F6" }}>
            {stage !== "pulling" && stage !== "knowledge_base"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : stage === "knowledge_base"
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Database size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage !== "pulling" && stage !== "knowledge_base" ? "text-green-700" : stage === "knowledge_base" ? "text-navy" : "text-ink-light"}`}>
              2. Knowledge base + bank rules pre-match
            </div>
            <div className="text-xs text-ink-slate mt-0.5">Instant matches for ~200 known vendors + your prior categorizations</div>
          </div>
        </div>

        {/* Row 3 */}
        <div className="flex items-start gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage === "web_search" ? "#D1FAE5" : stage === "ai" ? "#E8F2F0" : "#F3F4F6" }}>
            {stage === "web_search"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : stage === "ai"
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Sparkles size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage === "web_search" ? "text-green-700" : stage === "ai" ? "text-navy" : "text-ink-light"}`}>
              3. AI categorization (Claude)
            </div>
            <div className="text-xs text-ink-slate mt-0.5">Batched call for unknown vendors</div>
          </div>
        </div>

        {/* Row 4 — web search with inline Skip button */}
        <div className="flex items-center gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: webSearchActive ? "#E8F2F0" : "#F3F4F6" }}>
            {webSearchActive
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Search size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${webSearchActive ? "text-navy" : "text-ink-light"}`}>
              4. Web search for low-confidence vendors
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              One search per unique unknown vendor — results cached for next time
            </div>
          </div>
          {webSearchActive && (
            skipped ? (
              <span style={{ fontSize: 12, fontWeight: 600, color: "#D97706", flexShrink: 0 }}>
                Skipping…
              </span>
            ) : (
              <button
                onClick={skipWebSearch}
                disabled={skipping}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #D1D5DB",
                  background: "#FFFFFF",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#374151",
                  cursor: "pointer",
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  opacity: skipping ? 0.5 : 1,
                }}
              >
                {skipping
                  ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                  : <X size={11} />}
                {skipping ? "Skipping…" : "Skip this"}
              </button>
            )
          )}
        </div>

      </div>

      {/* Live web search log */}
      {(webSearchActive || webSearchLog.length > 0) && (
        <div className="rounded-lg overflow-hidden border border-gray-200 mb-5">
          <div className="bg-gray-900 px-3 py-2 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
            </div>
            <span className="text-xs text-gray-400 font-mono ml-1">web_search.log</span>
            {webSearchActive && <Loader2 size={11} className="ml-auto text-teal animate-spin" />}
          </div>
          <div className="bg-gray-950 px-4 py-3 font-mono text-xs text-green-400 min-h-[60px] max-h-[180px] overflow-y-auto space-y-1">
            {webSearchLog.length === 0 ? (
              <span className="text-gray-500">Waiting for first batch...</span>
            ) : (
              webSearchLog.map((line, i) => (
                <div key={i} className="leading-relaxed">
                  <span className="text-gray-500">{line.split(" ").slice(0, 2).join(" ")} </span>
                  <span>{line.split(" ").slice(2).join(" ")}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="space-y-2 text-sm">
        <div className="flex justify-between py-2 border-b border-gray-100">
          <span className="text-ink-slate">Transactions pulled</span>
          <span className="font-semibold text-navy">{stats?.pulled || "..."}</span>
        </div>
        <div className="flex justify-between py-2 border-b border-gray-100">
          <span className="text-ink-slate">Skipped (reconciled)</span>
          <span className="font-semibold text-navy">{stats?.skipped_reconciled || 0}</span>
        </div>
        <div className="flex justify-between py-2">
          <span className="text-ink-slate">Skipped (closed period)</span>
          <span className="font-semibold text-navy">{stats?.skipped_closed || 0}</span>
        </div>
      </div>

      <p className="text-xs text-ink-light text-center mt-5">
        Total time: usually 30-60s for the AI step + ~2s per unique unknown vendor for web search.
        Page auto-refreshes when done.
      </p>
    </div>
  );
}
