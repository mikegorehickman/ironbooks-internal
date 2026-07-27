import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { FileText, Download, Calendar, CheckCircle2 } from "lucide-react";
import { CreateReportButton } from "./create-report-button";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";

export const dynamic = "force-dynamic";

/**
 * Portal · Cleanup Reports
 *
 * Lists every completed bookkeeping cleanup period for this client and
 * lets them download the same branded PDF report Mike sends after each
 * cleanup. Auth-scoped to the signed-in portal user's client via
 * resolvePortalContext — clients never see other clients' reports.
 *
 * What constitutes "a cleanup period":
 *   - A reclass_jobs row with status='complete' AND month_closed_at set
 *     (= formally closed period — most authoritative signal)
 *   - Plus any non-month-close reclass_jobs that completed (for clients
 *     who haven't adopted the formal month-close workflow yet)
 *
 * Periods are deduplicated by (date_range_start, date_range_end) — if
 * the bookkeeper ran multiple jobs over the same window we surface the
 * window once, not per-job.
 */
export default async function PortalCleanupReportsPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok)
    return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();

  // Pull every completed reclass job for this client. We bucket by window
  // afterwards so multiple jobs over the same period collapse to one card.
  // Cast through `any` because month_closed_at + status are present in the
  // real schema but stale in the generated types — same pattern used
  // elsewhere in this codebase.
  const { data: rawJobs } = await (service as any)
    .from("reclass_jobs")
    .select(
      "id, status, workflow, date_range_start, date_range_end, month_closed_at, execution_completed_at, created_at"
    )
    .eq("client_link_id", ctx.clientLinkId)
    .eq("status", "complete")
    .order("date_range_end", { ascending: false, nullsFirst: false });

  const jobs = (rawJobs || []) as Array<{
    id: string;
    workflow: string | null;
    date_range_start: string | null;
    date_range_end: string | null;
    month_closed_at: string | null;
    execution_completed_at: string | null;
    created_at: string | null;
  }>;

  // Bucket by (start, end) — same window, multiple jobs = one card.
  const buckets = new Map<
    string,
    {
      start: string;
      end: string;
      jobCount: number;
      monthClosed: boolean;
      latestCompletedAt: string | null;
      workflows: Set<string>;
    }
  >();
  for (const j of jobs) {
    if (!j.date_range_start || !j.date_range_end) continue;
    const key = `${j.date_range_start}_${j.date_range_end}`;
    const existing = buckets.get(key);
    const completedAt = j.execution_completed_at || j.month_closed_at || j.created_at;
    if (existing) {
      existing.jobCount++;
      if (j.month_closed_at) existing.monthClosed = true;
      if (j.workflow) existing.workflows.add(j.workflow);
      if (completedAt && (!existing.latestCompletedAt || completedAt > existing.latestCompletedAt)) {
        existing.latestCompletedAt = completedAt;
      }
    } else {
      buckets.set(key, {
        start: j.date_range_start,
        end: j.date_range_end,
        jobCount: 1,
        monthClosed: !!j.month_closed_at,
        latestCompletedAt: completedAt,
        workflows: new Set(j.workflow ? [j.workflow] : []),
      });
    }
  }
  const periods = Array.from(buckets.values()).sort((a, b) =>
    b.end.localeCompare(a.end)
  );

  // Client-generated reports — PDFs saved by POST /api/portal/cleanup-report/
  // generate into the client's own folder in the private uploads bucket.
  // Filename shape: <ts>-Cleanup-Report-<start>-to-<end>.pdf
  let savedReports: Array<{
    path: string;
    name: string;
    start: string | null;
    end: string | null;
    createdAt: string | null;
  }> = [];
  try {
    const { data: files } = await service.storage
      .from(CLIENT_UPLOADS_BUCKET)
      .list(`${ctx.clientLinkId}/reports`, {
        limit: 100,
        sortBy: { column: "created_at", order: "desc" },
      });
    savedReports = ((files as any[]) || [])
      .filter((f) => f.name?.endsWith(".pdf"))
      .map((f) => {
        const m = f.name.match(/Cleanup-Report-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/);
        return {
          path: `${ctx.clientLinkId}/reports/${f.name}`,
          name: f.name.replace(/^\d{10,}-/, ""),
          start: m?.[1] || null,
          end: m?.[2] || null,
          createdAt: f.created_at || null,
        };
      });
  } catch {
    savedReports = [];
  }

  // BS cleanup wizard reports (published snapshots from cleanup_reports table)
  let bsReports: Array<{
    id: string;
    ai_summary: string | null;
    published_at: string | null;
    report_data: any;
  }> = [];
  try {
    const { data: cr } = await service
      .from("cleanup_reports" as any)
      .select("id, ai_summary, published_at, report_data")
      .eq("client_link_id", ctx.clientLinkId)
      .eq("published_to_portal", true)
      .order("published_at", { ascending: false });
    bsReports = (cr as any[]) || [];
  } catch {
    bsReports = [];
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">
          Cleanup Reports
        </div>
        <h1 className="text-3xl font-bold text-navy mt-1">
          Your bookkeeping cleanup history
        </h1>
        <div className="text-sm text-ink-slate mt-1">
          Branded PDF reports for every period your books were cleaned up.
          Share them with your accountant, lender, or tax preparer — they show
          exactly what was reviewed and reconciled.
        </div>
      </div>

      {/* Self-serve report builder — pick any period, the PDF saves below */}
      <CreateReportButton />

      {savedReports.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
            Your generated reports
          </h2>
          {savedReports.map((r) => (
            <div
              key={r.path}
              className="bg-white border border-cardline rounded-2xl p-4 md:p-5 flex items-center justify-between gap-4 flex-wrap hover:border-teal-light transition-colors"
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div className="shrink-0 w-10 h-10 rounded-lg bg-teal-lighter flex items-center justify-center">
                  <FileText size={18} className="text-teal" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-navy">
                    {r.start && r.end ? formatPeriodLabel(r.start, r.end) : r.name}
                  </div>
                  <div className="text-xs text-ink-slate mt-1 flex items-center gap-2 flex-wrap">
                    <Calendar size={12} />
                    {r.start && r.end ? (
                      <>
                        {r.start} → {r.end}
                      </>
                    ) : null}
                    {r.createdAt && (
                      <>
                        <span className="text-ink-slate/50">·</span>
                        <span>Created {new Date(r.createdAt).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <a
                href={`/api/client-files/download?path=${encodeURIComponent(r.path)}`}
                className="shrink-0 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
              >
                <Download size={14} />
                Download PDF
              </a>
            </div>
          ))}
        </div>
      )}

      {bsReports.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">
            Balance Sheet Cleanup Reports
          </h2>
          {bsReports.map((r) => (
            <div
              key={r.id}
              className="bg-white border border-cardline rounded-2xl p-4 md:p-5"
            >
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-10 h-10 rounded-lg bg-teal-lighter flex items-center justify-center">
                  <FileText size={18} className="text-teal" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-navy">
                    BS Cleanup Report
                    {r.published_at && (
                      <span className="text-xs font-normal text-ink-slate ml-2">
                        {new Date(r.published_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {r.ai_summary && (
                    <p className="text-xs text-ink-slate mt-2 leading-relaxed">
                      {r.ai_summary}
                    </p>
                  )}
                  {r.report_data?.health_score && (
                    <div className="text-xs text-ink-light mt-1">
                      Health Score: {r.report_data.health_score.overall_score}/100
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {periods.length === 0 && bsReports.length === 0 && savedReports.length === 0 ? (
        <div className="bg-white border border-cardline rounded-2xl p-10 text-center">
          <FileText size={32} className="mx-auto text-ink-slate mb-3" />
          <div className="text-sm font-semibold text-navy">
            No cleanup reports available yet
          </div>
          <p className="text-xs text-ink-slate mt-2 max-w-md mx-auto">
            Reports from completed Ironbooks cleanups appear here automatically
            — or build your own for any period with the button above.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {periods.map((p) => {
            const downloadUrl = `/api/portal/cleanup-report?start=${p.start}&end=${p.end}`;
            const filename = `Ironbooks Cleanup ${p.start} to ${p.end}.pdf`;
            return (
              <div
                key={`${p.start}_${p.end}`}
                className="bg-white border border-cardline rounded-2xl p-4 md:p-5 flex items-center justify-between gap-4 flex-wrap hover:border-teal-light transition-colors"
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-teal-lighter flex items-center justify-center">
                    <FileText size={18} className="text-teal" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-bold text-navy">
                        {formatPeriodLabel(p.start, p.end)}
                      </div>
                      {p.monthClosed && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                          <CheckCircle2 size={10} />
                          Month closed
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-slate mt-1 flex items-center gap-2 flex-wrap">
                      <Calendar size={12} />
                      {p.start} → {p.end}
                      {p.latestCompletedAt && (
                        <>
                          <span className="text-ink-slate/50">·</span>
                          <span>
                            Finalized{" "}
                            {new Date(p.latestCompletedAt).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <a
                  href={downloadUrl}
                  download={filename}
                  className="shrink-0 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
                >
                  <Download size={14} />
                  Download PDF
                </a>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[11px] text-ink-slate/70 max-w-2xl">
        PDFs are generated from your live QuickBooks data and the Ironbooks
        cleanup audit trail for the requested period. Reports you create with
        the button above are saved here; the per-period downloads below them
        are freshly built on each click.
      </div>
    </div>
  );
}

/** Render "January 2026" if the range is a clean calendar month, else
 *  "Jan 15 → Mar 31, 2026". Saves the client from squinting at YYYY-MM-DD. */
function formatPeriodLabel(start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  const sameMonth =
    s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth();
  const firstOfMonth = s.getUTCDate() === 1;
  const lastOfMonth = e.getUTCDate() >= 28 && new Date(e.getUTCFullYear(), e.getUTCMonth() + 1, 0).getUTCDate() === e.getUTCDate();

  if (sameMonth && firstOfMonth && lastOfMonth) {
    // Clean calendar month
    return s.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  }

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const yearSuffix =
    s.getUTCFullYear() === e.getUTCFullYear() ? `, ${e.getUTCFullYear()}` : "";
  return `${fmt(s)} → ${fmt(e)}${yearSuffix}`;
}
