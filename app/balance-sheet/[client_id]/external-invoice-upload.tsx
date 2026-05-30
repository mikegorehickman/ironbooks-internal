"use client";

/**
 * BS Cleanup — Jobber / DripJobs invoice import card.
 *
 * Renders at the top of the BS Cleanup landing page. Lets the bookkeeper
 * drop a Jobber .xlsx or DripJobs .csv per client; on upload, parses
 * server-side and stashes normalized rows. Once imported, the downstream
 * duplicate detector consumes the lineage_key (Jobber Job # or DripJobs
 * Proposal Name) to distinguish revisions / progress billing from real
 * duplicates.
 *
 * Two upload slots, one per source. Re-upload replaces the prior import.
 * Shows last-imported timestamp + row counts so the bookkeeper knows
 * when the dedup logic is "armed" vs "running blind."
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2, Upload, FileSpreadsheet, X, AlertCircle, CheckCircle2,
  Layers, Briefcase,
} from "lucide-react";

type Source = "jobber" | "dripjobs";

interface ImportSummary {
  id: string;
  source: Source;
  filename: string | null;
  uploaded_at: string;
  row_count: number;
  invoice_count: number;
  parse_warnings?: string[] | null;
  users?: { full_name: string | null } | null;
}

interface Props {
  clientLinkId: string;
}

const SOURCES: Array<{
  key: Source;
  label: string;
  hint: string;
  accept: string;
  icon: typeof Briefcase;
}> = [
  {
    key: "jobber",
    label: "Jobber",
    hint: "Export from Jobber: Reports → Invoices → Download .xlsx",
    accept: ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    icon: Briefcase,
  },
  {
    key: "dripjobs",
    label: "DripJobs",
    hint: "Export from DripJobs: Invoices → Export → .csv",
    accept: ".csv,text/csv",
    icon: Layers,
  },
];

export function ExternalInvoiceUpload({ clientLinkId }: Props) {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<Source | null>(null);
  const [error, setError] = useState<string>("");
  const [lastResult, setLastResult] = useState<
    | { source: Source; row_count: number; invoice_count: number; warnings: string[] }
    | null
  >(null);
  const inputRefs = useRef<Record<Source, HTMLInputElement | null>>({
    jobber: null,
    dripjobs: null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/external-invoices`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const data = await res.json();
      setImports(data.imports || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [clientLinkId]);

  useEffect(() => {
    load();
  }, [load]);

  async function upload(source: Source, file: File) {
    setUploading(source);
    setError("");
    setLastResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("source", source);
      const res = await fetch(`/api/clients/${clientLinkId}/external-invoices`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setLastResult({
        source,
        row_count: data.row_count,
        invoice_count: data.invoice_count,
        warnings: data.warnings || [],
      });
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(null);
      // Reset the input so re-selecting the same file fires onChange
      const el = inputRefs.current[source];
      if (el) el.value = "";
    }
  }

  async function clearImport(source: Source) {
    if (!confirm(`Remove the ${source === "jobber" ? "Jobber" : "DripJobs"} import? You can re-upload anytime.`)) {
      return;
    }
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/external-invoices?source=${source}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const findImport = (s: Source) => imports.find((i) => i.source === s);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-navy flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-teal" />
            Job-app invoice imports
          </h2>
          <p className="text-xs text-ink-slate mt-0.5 leading-snug">
            Upload the client&apos;s Jobber or DripJobs invoice export so the
            duplicate detector can tell revisions and progress billing apart
            from real duplicates. Re-upload anytime to refresh.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800 flex items-start gap-2">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {lastResult && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800 flex items-start gap-2">
          <CheckCircle2 size={13} className="mt-0.5 flex-shrink-0" />
          <span>
            Imported {lastResult.row_count} row{lastResult.row_count === 1 ? "" : "s"}{" "}
            ({lastResult.invoice_count} invoices) from {lastResult.source === "jobber" ? "Jobber" : "DripJobs"}.
            {lastResult.warnings.length > 0 &&
              ` ${lastResult.warnings.length} warning${lastResult.warnings.length === 1 ? "" : "s"}.`}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {SOURCES.map(({ key, label, hint, accept, icon: Icon }) => {
          const imp = findImport(key);
          const busy = uploading === key;
          return (
            <div
              key={key}
              className={`rounded-xl border ${
                imp ? "border-teal/30 bg-teal-lighter/30" : "border-gray-200 bg-gray-50"
              } p-3.5 space-y-2`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon
                    size={14}
                    className={imp ? "text-teal flex-shrink-0" : "text-ink-slate flex-shrink-0"}
                  />
                  <span className="text-sm font-bold text-navy truncate">{label}</span>
                  {imp && (
                    <span className="text-[10px] font-semibold text-teal bg-white border border-teal/30 px-1.5 py-0.5 rounded-full">
                      Active
                    </span>
                  )}
                </div>
                {imp && (
                  <button
                    onClick={() => clearImport(key)}
                    className="p-1 rounded hover:bg-red-50 text-ink-light hover:text-red-600 transition-colors"
                    title="Remove import"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {loading ? (
                <div className="text-xs text-ink-light flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" /> Loading…
                </div>
              ) : imp ? (
                <div className="text-[11px] text-ink-slate leading-snug space-y-0.5">
                  <div>
                    <span className="font-mono text-navy">{imp.filename || "(no filename)"}</span>
                  </div>
                  <div>
                    {imp.invoice_count} invoice{imp.invoice_count === 1 ? "" : "s"} · {imp.row_count} row{imp.row_count === 1 ? "" : "s"}
                  </div>
                  <div>
                    Uploaded {new Date(imp.uploaded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    {imp.users?.full_name ? ` by ${imp.users.full_name.split(" ")[0]}` : ""}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-ink-light leading-snug">{hint}</p>
              )}

              <div>
                <input
                  ref={(el) => {
                    inputRefs.current[key] = el;
                  }}
                  type="file"
                  accept={accept}
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload(key, f);
                  }}
                />
                <button
                  onClick={() => inputRefs.current[key]?.click()}
                  disabled={busy}
                  className={`w-full text-xs font-semibold py-1.5 px-3 rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                    imp
                      ? "border border-gray-200 hover:border-teal text-ink-slate hover:text-teal bg-white"
                      : "bg-teal hover:bg-teal-dark text-white"
                  } disabled:opacity-50`}
                >
                  {busy ? (
                    <>
                      <Loader2 size={11} className="animate-spin" /> Uploading…
                    </>
                  ) : (
                    <>
                      <Upload size={11} /> {imp ? "Replace import" : `Upload ${label} export`}
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
