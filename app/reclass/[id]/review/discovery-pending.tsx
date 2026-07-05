"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, AlertCircle, CheckCircle2, Sparkles, Search, Database, RotateCcw, XCircle, PlayCircle } from "lucide-react";

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
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState<string>("");
  const [elapsed, setElapsed] = useState<number>(0);
  const [cancelling, setCancelling] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [wsProgress, setWsProgress] = useState<{ done: number; total: number } | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("starting");
  const [wsPendingCount, setWsPendingCount] = useState<number | null>(null);
  const [wsStarting, setWsStarting] = useState(false);
  const [wsSkipping, setWsSkipping] = useState(false);
  const [wsError, setWsError] = useState<string>("");
  const [aiContinuing, setAiContinuing] = useState(false);
  const [aiError, setAiError] = useState<string>("");

  // Stall detection: a hung background task keeps the job in `executing`
  // with no advancing progress until the DB watchdog fails it (up to ~40
  // min later). That's an eternity of bare spinner for a new bookkeeper, so
  // we surface a soft "this may be stuck" warning after a few quiet minutes —
  // well before the watchdog — with the recovery action inline.
  const lastAdvanceRef = useRef<number>(Date.now());
  const progressSigRef = useRef<string>("");
  const statusRef = useRef<string>("starting");
  const [quietMs, setQuietMs] = useState<number>(0);
  const STALL_MS = 180_000; // 3 min of no forward progress while executing

  useEffect(() => {
    const t = setInterval(() => {
      setElapsed((s) => s + 1);
      setQuietMs(Date.now() - lastAdvanceRef.current);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    let consecutiveFailures = 0;
    async function poll() {
      try {
        const res = await fetch(`/api/reclass/${jobId}/status`);
        if (!res.ok) {
          // Surface the real error from the body. Auth expiry (401) is the
          // most common cause when discovery has been running a long time.
          const body = await res.json().catch(() => ({}));
          const msg = body?.error || `Status check returned HTTP ${res.status}`;
          // Transient blips (502/503/504, occasional network errors) shouldn't
          // tank the poll loop on the first hit. Retry 2 times before giving up.
          consecutiveFailures++;
          if (consecutiveFailures < 3 && res.status >= 500 && res.status !== 401) {
            if (!cancelled) setTimeout(poll, 2000);
            return;
          }
          throw new Error(
            res.status === 401
              ? "Your session expired. Reload the page and sign in again — discovery is still running in the background."
              : `${msg}${body?.stack_first_frame ? ` (at ${body.stack_first_frame})` : ""}`
          );
        }
        consecutiveFailures = 0;
        const data = await res.json();
        if (cancelled) return;

        setStatus(data.status);
        setStats(data.stats);
        if (data.ai_progress) setAiProgress(data.ai_progress);
        if (data.web_search_progress) setWsProgress(data.web_search_progress);
        if (data.phase !== undefined) setPhase(data.phase);
        if (data.web_search_pending_count !== undefined && data.web_search_pending_count !== null) {
          setWsPendingCount(data.web_search_pending_count);
        }

        // Reset the stall clock whenever anything actually moves (status,
        // phase, or a progress counter). If the signature stops changing, the
        // background task has likely died and the stall warning kicks in.
        statusRef.current = data.status;
        const sig = [
          data.status,
          data.phase ?? "",
          data.ai_progress?.done ?? "",
          data.web_search_progress?.done ?? "",
          data.stats?.pulled ?? "",
        ].join("|");
        if (sig !== progressSigRef.current) {
          progressSigRef.current = sig;
          lastAdvanceRef.current = Date.now();
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
        // web_search_paused: stop polling and show the choice prompt.
        // Polling resumes when the bookkeeper clicks "Web search" (status flips
        // back to executing).
        if (data.status === "web_search_paused") return;
        // ai_paused: large job paused between chunked-categorization runs. Stop
        // polling and show the Continue gate; polling resumes on Continue.
        if (data.status === "ai_paused") return;

        setTimeout(poll, 2000);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    }

    poll();
    return () => { cancelled = true; };
  }, [jobId, router]);

  // While parked at a Continue gate (ai_paused / web_search_paused), the main
  // poll loop stops — so if the job is finished elsewhere (another session, a
  // background run, the manager's "Get unstuck"), this page can sit on a stale
  // "Start categorization" gate. Keep a slow heartbeat + a focus/visibility
  // re-check so it auto-advances to review (or execute) once the job moves on.
  useEffect(() => {
    if (status !== "ai_paused" && status !== "web_search_paused") return;
    let stop = false;
    async function recheck() {
      if (stop) return;
      try {
        const r = await fetch(`/api/reclass/${jobId}/status`);
        if (!r.ok) return;
        const d = await r.json();
        if (stop) return;
        if (d.status === "in_review") { window.location.reload(); return; }
        if (d.status === "complete") { window.location.href = `/reclass/${jobId}/execute`; return; }
        if (d.status !== status) setStatus(d.status); // moved on elsewhere (e.g. executing) — re-render
      } catch { /* transient — next tick retries */ }
    }
    const iv = setInterval(recheck, 15000);
    const onWake = () => recheck();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      stop = true;
      clearInterval(iv);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [status, jobId]);

  async function cancelJob() {
    if (!confirm("Cancel this job? It will be marked as failed and you can start a new one.")) return;
    setCancelling(true);
    try {
      await fetch(`/api/reclass/${jobId}/cancel`, { method: "POST" });
      window.location.reload();
    } catch {
      setCancelling(false);
    }
  }

  async function runWebSearch() {
    setWsStarting(true);
    setWsError("");
    try {
      const res = await fetch(`/api/reclass/${jobId}/web-search-chunk`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setWsError(data.error || `Failed (${res.status})`);
        setWsStarting(false);
        return;
      }
      // Backend flipped status back to executing; trigger a fresh poll cycle.
      setStatus("executing");
      setWsStarting(false);
      // Re-enter poll loop
      async function pollAfterStart() {
        try {
          const r = await fetch(`/api/reclass/${jobId}/status`);
          if (!r.ok) return;
          const d = await r.json();
          setStatus(d.status);
          setStats(d.stats);
          if (d.web_search_progress) setWsProgress(d.web_search_progress);
          if (d.phase !== undefined) setPhase(d.phase);
          if (d.status === "in_review") {
            window.location.reload();
            return;
          }
          if (d.status === "failed") {
            setError(d.error_message || "Web search failed");
            return;
          }
          if (d.status === "web_search_paused") return; // shouldn't happen with new flow
          setTimeout(pollAfterStart, 2000);
        } catch {}
      }
      pollAfterStart();
    } catch {
      setWsError("Network error — try again");
      setWsStarting(false);
    }
  }

  async function skipWebSearch() {
    setWsSkipping(true);
    setWsError("");
    try {
      const res = await fetch(`/api/reclass/${jobId}/skip-web-search`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setWsError(data.error || `Failed (${res.status})`);
        setWsSkipping(false);
        return;
      }
      // skip-web-search instantly flips paused → in_review. Reload to review.
      window.location.reload();
    } catch {
      setWsError("Network error — try again");
      setWsSkipping(false);
    }
  }

  // Continue the chunked AI categorization: runs the next batch in a fresh
  // invocation, then re-enters polling (which stops again at ai_paused for the
  // next approval, or moves on to web_search_paused / in_review when done).
  async function continueAiChunk() {
    setAiContinuing(true);
    setAiError("");
    try {
      const res = await fetch(`/api/reclass/${jobId}/categorize-chunk`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiError(data.error || `Failed (${res.status})`);
        setAiContinuing(false);
        return;
      }
      setStatus("executing");
      setAiContinuing(false);
      async function pollAfterContinue() {
        try {
          const r = await fetch(`/api/reclass/${jobId}/status`);
          if (!r.ok) { setTimeout(pollAfterContinue, 2000); return; }
          const d = await r.json();
          setStatus(d.status);
          setStats(d.stats);
          if (d.ai_progress) setAiProgress(d.ai_progress);
          if (d.phase !== undefined) setPhase(d.phase);
          if (d.web_search_pending_count !== undefined && d.web_search_pending_count !== null) {
            setWsPendingCount(d.web_search_pending_count);
          }
          if (d.status === "in_review") { window.location.reload(); return; }
          if (d.status === "failed") { setError(d.error_message || "Categorization failed"); return; }
          if (d.status === "web_search_paused") return; // show ws prompt
          if (d.status === "ai_paused") return; // show gate again for next batch
          setTimeout(pollAfterContinue, 2000);
        } catch { setTimeout(pollAfterContinue, 2000); }
      }
      pollAfterContinue();
    } catch {
      setAiError("Network error — try again");
      setAiContinuing(false);
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
            href="/today"
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Back to Today
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

  // ── WEB SEARCH CHOICE PROMPT ───────────────────────────────────────────
  // AI categorization just finished and there are N vendors that could benefit
  // from web search. Bookkeeper decides: run it, or skip to manual review.
  if (status === "web_search_paused" && !wsStarting) {
    const n = wsPendingCount ?? 0;
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8 space-y-5">
        <div className="flex items-start gap-3 p-4 bg-teal-lighter/50 text-navy rounded-lg border border-teal/20">
          <CheckCircle2 className="flex-shrink-0 mt-0.5 text-teal" size={20} />
          <div>
            <div className="font-semibold mb-1">AI categorization complete</div>
            <div className="text-sm text-ink-slate">
              {n > 0
                ? `There ${n === 1 ? "is" : "are"} ${n} uncategorized vendor${n === 1 ? "" : "s"} the AI couldn't confidently place. Web search can look them up online and try to upgrade them automatically.`
                : "Some vendors couldn't be confidently categorized. Run web search to try to upgrade them, or skip to manual review."}
            </div>
          </div>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between py-2 border-b border-gray-100">
            <span className="text-ink-slate">Transactions auto-approved</span>
            <span className="font-semibold text-navy">{stats?.auto_approve || 0}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-100">
            <span className="text-ink-slate">Needs review</span>
            <span className="font-semibold text-navy">{stats?.needs_review || 0}</span>
          </div>
          <div className="flex justify-between py-2">
            <span className="text-ink-slate">Vendors to web-search</span>
            <span className="font-semibold text-navy">{n}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={runWebSearch}
            disabled={wsStarting || wsSkipping}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50"
          >
            {wsStarting ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={15} />}
            Web search {n} vendor{n === 1 ? "" : "s"}
            <span className="text-xs opacity-80">(~{Math.max(1, Math.ceil(n / 10) * 0.5)} min)</span>
          </button>

          <button
            onClick={skipWebSearch}
            disabled={wsStarting || wsSkipping}
            className="inline-flex items-center gap-2 text-sm font-semibold text-ink-slate hover:text-navy border border-gray-200 px-4 py-2.5 rounded-lg disabled:opacity-50"
          >
            {wsSkipping ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
            Continue to manual review
          </button>

          {wsError && (
            <span className="text-sm font-semibold text-red-600">{wsError}</span>
          )}
        </div>

        <p className="text-xs text-ink-slate leading-relaxed">
          Web search uses Claude with internet access to identify unknown vendors and map them to the right account. Runs 10 vendors at a time in parallel — you can skip at any point if it's taking too long. Successful matches get cached as bank rules for future jobs.
        </p>
      </div>
    );
  }

  // ── CHUNKED CATEGORIZATION GATE ────────────────────────────────────────
  // Large job: AI categorization runs in approved batches so no single run can
  // time out. Show progress + a Continue button; each click runs the next batch
  // (up to ~10 min) then pauses back here. Pre-matched + skipped rows are
  // already saved; this only covers the lines that still need Claude.
  if (status === "ai_paused" && !aiContinuing) {
    const done = aiProgress?.done ?? 0;
    const total = aiProgress?.total ?? 0;
    const remaining = Math.max(0, total - done);
    const started = done > 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8 space-y-5">
        <div className="flex items-start gap-3 p-4 bg-teal-lighter/50 text-navy rounded-lg border border-teal/20">
          <Database className="flex-shrink-0 mt-0.5 text-teal" size={20} />
          <div>
            <div className="font-semibold mb-1">
              {started ? "Categorization paused — continue when ready" : "Large job — categorize in approved batches"}
            </div>
            <div className="text-sm text-ink-slate">
              {total} transaction{total === 1 ? "" : "s"} need AI categorization. To stay well
              within time limits, SNAP runs them in batches you approve — each run handles a
              batch (up to ~10 min) then pauses here.
              {started ? ` ${done} of ${total} done so far.` : ""}
            </div>
          </div>
        </div>

        {total > 0 && (
          <div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div className="bg-teal h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-ink-slate mt-1">{done} / {total} categorized ({pct}%)</div>
          </div>
        )}

        <div className="space-y-2 text-sm">
          <div className="flex justify-between py-2 border-b border-gray-100">
            <span className="text-ink-slate">Categorized so far</span>
            <span className="font-semibold text-navy">{done}</span>
          </div>
          <div className="flex justify-between py-2">
            <span className="text-ink-slate">Remaining to categorize</span>
            <span className="font-semibold text-navy">{remaining}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={continueAiChunk}
            disabled={aiContinuing}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50"
          >
            {aiContinuing ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={15} />}
            {started ? `Continue — categorize next batch` : "Start categorization"}
          </button>
          {aiError && <span className="text-sm font-semibold text-red-600">{aiError}</span>}
        </div>

        <p className="text-xs text-ink-slate leading-relaxed">
          Each batch is saved to QuickBooks-ready review as it finishes, so your progress is never
          lost — you can close this page and come back to continue. When all batches are done,
          you&apos;ll move to web search / manual review.
        </p>
      </div>
    );
  }

  // Stage detection driven by server-side phase markers (more reliable than
  // elapsed time). Falls back to time-based guess only when no phase yet.
  type Stage = "pulling" | "knowledge_base" | "ai" | "web_search" | "saving";
  function stageFromPhase(p: string | null): Stage {
    if (!p) return aiProgress ? "ai" : elapsed < 5 ? "pulling" : "knowledge_base";
    if (p.startsWith("pulling")) return "pulling";
    if (p.startsWith("fetching_accounts") || p.startsWith("pre_matching")) return "knowledge_base";
    if (p.startsWith("running_ai")) return "ai";
    if (p.startsWith("web_searching")) return "web_search";
    if (p.startsWith("saving")) return "saving";
    return aiProgress ? "ai" : "knowledge_base";
  }
  const stage: Stage = stageFromPhase(phase);

  // Friendly label for the current phase shown under the active step.
  //
  // The error_message field is shared between [phase] markers and
  // [ai_progress] / [web_search_progress] writes — so once AI batches
  // start running, the [phase] marker gets overwritten and `p` reads null.
  // Fall back to deriving the label from whichever progress counter is
  // active so the UI doesn't mis-show "Starting…" while AI is at batch
  // 61/102. (Lionetti Painting, May 2026.)
  function phaseLabel(p: string | null): string {
    if (p) {
      if (p.startsWith("pulling")) return "Pulling transactions from QuickBooks";
      if (p === "fetching_accounts") return "Fetching chart of accounts";
      if (p === "pre_matching") return "Matching against knowledge base + bank rules";
      if (p.startsWith("running_ai")) return `Running AI categorization — ${p.replace("running_ai", "").trim() || "starting"}`;
      if (p.startsWith("web_searching")) return `Web-searching unknown vendors — ${p.replace("web_searching", "").trim() || ""}`;
      if (p.startsWith("saving")) return `Saving results — ${p.replace("saving", "").trim() || ""}`;
      return p;
    }
    // Fallback when phase marker was overwritten by a progress write
    if (wsProgress) return "Web-searching unknown vendors";
    if (aiProgress) return "Running AI categorization";
    return "Starting…";
  }

  // Right-side counter on the phase banner — shows whichever progress is active.
  const activeCounter = aiProgress && stage === "ai"
    ? `${aiProgress.done} / ${aiProgress.total}`
    : wsProgress && stage === "web_search"
      ? `Batch ${wsProgress.done} / ${wsProgress.total}`
      : null;

  // Surfaced when discovery has been running but made no forward progress for
  // a few minutes — a strong hint the background task died (it'll be
  // watchdog-failed eventually, but this tells the bookkeeper now).
  const stalled = statusRef.current === "executing" && quietMs > STALL_MS;
  const quietMin = Math.max(1, Math.round(quietMs / 60000));

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-8">
      <div className="flex items-center gap-3 mb-2">
        <Loader2 className="animate-spin text-teal" size={24} />
        <h2 className="text-lg font-bold text-navy">Discovery in progress</h2>
        <span className="text-xs font-mono text-ink-slate">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </span>
        <button
          onClick={cancelJob}
          disabled={cancelling}
          className="ml-auto flex items-center gap-1 text-xs text-ink-slate hover:text-red-600 disabled:opacity-50"
          title="Cancel this job and start a fresh one"
        >
          {cancelling ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={13} />}
          {cancelling ? "Cancelling…" : "Cancel job"}
        </button>
      </div>
      <div className="mb-6 p-3 rounded-lg bg-teal-lighter/50 border border-teal/20 flex items-center gap-2">
        <Loader2 className="animate-spin text-teal flex-shrink-0" size={14} />
        <span className="text-sm font-semibold text-navy">{phaseLabel(phase)}</span>
        {activeCounter && (
          <span className="text-xs text-ink-slate ml-auto">{activeCounter}</span>
        )}
      </div>

      {/* Stall warning — no forward progress for a few minutes. Reassures the
          bookkeeper their data is safe and offers the recovery action inline,
          well before the DB watchdog would auto-fail it. */}
      {stalled && (
        <div className="mb-5 p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-2">
          <AlertCircle className="text-amber-600 flex-shrink-0 mt-0.5" size={16} />
          <div className="text-sm text-amber-900 leading-relaxed">
            <span className="font-semibold">Taking longer than usual</span> — no progress for{" "}
            {quietMin} min. Discovery normally finishes in 1–3 minutes; this can happen on a large
            date range or a stalled AI call. Nothing has been written to QuickBooks, so it&apos;s
            safe to{" "}
            <button
              onClick={cancelJob}
              disabled={cancelling}
              className="font-semibold underline hover:text-amber-950 disabled:opacity-50"
            >
              cancel and start a fresh reclass
            </button>{" "}
            (a narrower date range helps on big clients). If left alone, a watchdog will auto-fail
            it so it never hangs forever.
          </div>
        </div>
      )}

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
            style={{ backgroundColor: stage === "ai" || stage === "web_search" || stage === "saving" ? "#D1FAE5" : stage === "knowledge_base" ? "#E8F2F0" : "#F3F4F6" }}>
            {stage === "ai" || stage === "web_search" || stage === "saving"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : stage === "knowledge_base"
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Database size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage === "ai" || stage === "web_search" || stage === "saving" ? "text-green-700" : stage === "knowledge_base" ? "text-navy" : "text-ink-light"}`}>
              2. Knowledge base + bank rules pre-match
            </div>
            <div className="text-xs text-ink-slate mt-0.5">Instant matches for ~200 known vendors + your prior categorizations</div>
          </div>
        </div>

        {/* Row 3 */}
        <div className="flex items-center gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage === "web_search" || stage === "saving" ? "#D1FAE5" : stage === "ai" ? "#E8F2F0" : "#F3F4F6" }}>
            {stage === "web_search" || stage === "saving"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : stage === "ai"
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Sparkles size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage === "web_search" || stage === "saving" ? "text-green-700" : stage === "ai" ? "text-navy" : "text-ink-light"}`}>
              3. AI categorization (Claude)
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              {aiProgress
                ? `${aiProgress.done} of ${aiProgress.total} categorized`
                : "Sequential batches — ~15 lines per call, ~10–60s each"}
            </div>
          </div>
        </div>

        {/* Row 4 — Web search (only for unknown vendors AI couldn't confidently categorize) */}
        <div className="flex items-center gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage === "saving" ? "#D1FAE5" : stage === "web_search" ? "#E8F2F0" : "#F3F4F6" }}>
            {stage === "saving"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : stage === "web_search"
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Search size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage === "saving" ? "text-green-700" : stage === "web_search" ? "text-navy" : "text-ink-light"}`}>
              4. Web search for unknown vendors
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              {wsProgress
                ? `Batch ${wsProgress.done} of ${wsProgress.total} complete`
                : "Looks up vendors the AI couldn't confidently identify — 10 per batch in parallel"}
            </div>
          </div>
        </div>

      </div>

      {/* Progress bar — driven by whichever phase is currently active */}
      {(() => {
        const active = stage === "web_search" && wsProgress
          ? wsProgress
          : stage === "ai" && aiProgress
            ? aiProgress
            : null;
        if (!active || active.total === 0) return null;
        return (
          <div className="mb-5">
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className="bg-teal h-2 rounded-full transition-all"
                style={{ width: `${Math.round((active.done / active.total) * 100)}%` }}
              />
            </div>
          </div>
        );
      })()}

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
        Page auto-refreshes when discovery completes. If anything goes wrong, click Cancel job
        and start a fresh one.
      </p>
    </div>
  );
}
