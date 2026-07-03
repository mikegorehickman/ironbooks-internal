"use client";

import { useEffect, useState } from "react";
import { FolderOpen, FileText, Paperclip, Download, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import type { PortalDocument } from "@/app/api/portal/documents/route";

const INITIAL_VISIBLE = 8;

/** Other panels fire this after an upload so the list refreshes in place. */
export const DOCUMENTS_CHANGED_EVENT = "snap:documents-changed";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function fmtSize(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * "Your documents" — the permanent archive under the messages thread. Every
 * statement the client has uploaded and every file sent either direction in
 * the thread, newest first, each with a download link (served through the
 * signed-URL gateway, so the private bucket stays private).
 */
export function DocumentsPanel({ initialDocuments }: { initialDocuments?: PortalDocument[] }) {
  const [docs, setDocs] = useState<PortalDocument[]>(initialDocuments || []);
  const [loading, setLoading] = useState(!initialDocuments);
  const [showAll, setShowAll] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/portal/documents");
      if (!res.ok) return; // keep whatever we have
      const json = await res.json();
      setDocs(json.documents || []);
    } catch {
      /* keep prior state */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DOCUMENTS_CHANGED_EVENT, onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = showAll ? docs : docs.slice(0, INITIAL_VISIBLE);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-teal/10 flex-shrink-0">
          <FolderOpen size={18} className="text-teal" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-navy text-sm">Your documents</h3>
          <p className="text-xs text-ink-slate mt-0.5 leading-relaxed">
            Every statement and file you&apos;ve uploaded (and anything we&apos;ve sent you) is saved here.
          </p>
        </div>
        {docs.length > 0 && (
          <span className="text-[11px] font-semibold text-ink-slate bg-slate-100 rounded-full px-2 py-0.5 flex-shrink-0">
            {docs.length} file{docs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-ink-slate">
          <Loader2 size={14} className="animate-spin text-teal" /> Loading your documents…
        </div>
      ) : docs.length === 0 ? (
        <p className="mt-4 text-sm text-ink-slate bg-slate-50 border border-slate-200 rounded-lg px-3 py-3">
          Nothing here yet — statements and files you upload above will be saved and listed for you.
        </p>
      ) : (
        <>
          <div className="mt-4 border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="text-[11px] uppercase tracking-wide text-ink-slate">
                  <th className="text-left font-semibold px-3 py-2">File</th>
                  <th className="text-left font-semibold px-3 py-2">Account</th>
                  <th className="text-left font-semibold px-3 py-2 hidden sm:table-cell">Period</th>
                  <th className="text-left font-semibold px-3 py-2 hidden md:table-cell">Uploaded</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((d) => {
                  const size = fmtSize(d.size);
                  const sub =
                    d.kind === "attachment"
                      ? [d.direction === "to_client" ? "From your bookkeeper" : "Sent by you", size].filter(Boolean).join(" · ")
                      : null;
                  return (
                    <tr key={d.key} className="bg-white hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          {d.kind === "statement" ? (
                            <FileText size={16} className="text-teal flex-shrink-0" />
                          ) : (
                            <Paperclip size={16} className="text-slate-400 flex-shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-navy truncate max-w-[220px]">{d.name}</div>
                            {sub && <div className="text-[11px] text-ink-slate truncate">{sub}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {d.kind === "statement" ? (
                          d.needs_match ? (
                            <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 font-semibold whitespace-nowrap">
                              needs account
                            </span>
                          ) : (
                            <span className="text-sm text-navy">{d.account || "—"}</span>
                          )
                        ) : (
                          <span className="text-sm text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 hidden sm:table-cell text-sm text-ink-slate whitespace-nowrap">
                        {d.period || "—"}
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell text-sm text-ink-slate whitespace-nowrap">
                        {fmtDate(d.date)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {d.path && (
                          <a
                            href={`/api/client-files/download?path=${encodeURIComponent(d.path)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-teal-dark hover:text-teal border border-slate-200 hover:border-teal/40 rounded-lg px-2.5 py-1.5"
                          >
                            <Download size={13} /> View
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {docs.length > INITIAL_VISIBLE && (
            <button
              onClick={() => setShowAll((s) => !s)}
              className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-teal-dark hover:text-teal"
            >
              {showAll ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showAll ? "Show fewer" : `Show all ${docs.length} files`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
