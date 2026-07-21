"use client";

import { useEffect, useRef, useState } from "react";
import {
  FileText, Upload, Loader2, Download, CheckCircle2, AlertTriangle, Sparkles, Eye,
  ChevronDown, ChevronRight, ArrowDownUp,
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import {
  statementEndLabel,
  formatStatementBalance,
} from "@/lib/statement-format";

type Statement = {
  id: string;
  display_name: string;
  original_name: string | null;
  matched_account_name: string | null;
  match_confidence: string | null;
  account_label: string | null;
  last4: string | null;
  account_kind: string | null;
  period_month: number | null;
  period_year: number | null;
  statement_end_date: string | null;
  ending_balance: number | null;
  status: string;
  storage_path: string;
  uploaded_via: string;
  created_at: string;
};

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const periodLabel = (s: Statement) =>
  s.period_month && s.period_year ? `${MONTHS[s.period_month]} ${s.period_year}` : s.period_year ? String(s.period_year) : "—";

const CONF: Record<string, { label: string; cls: string }> = {
  high: { label: "Matched", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  medium: { label: "Likely match", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  low: { label: "Low confidence", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  none: { label: "Unmatched", cls: "bg-gray-100 text-gray-600 border-gray-200" },
};

/**
 * Statements section on the client profile. Bookkeepers can upload a client's
 * bank/CC/loan statements; each one is read by AI (account + period), matched
 * to a QBO account, renamed, and filed here. Clients can also upload from the
 * portal Messages page — those land in this same list.
 */
export function StatementsCard({ clientLinkId }: { clientLinkId: string }) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(null);
  // Per-account groups are COLLAPSED by default — track which ones the user has
  // opened. Empty set = everything collapsed (the default on load).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function load() {
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/statements`);
      const json = await res.json();
      if (res.ok) setStatements(json.statements || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [clientLinkId]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const files = Array.from(fileList);
    const supabase = createBrowserSupabase();
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setBusy(files.length > 1 ? `Reading ${i + 1} of ${files.length}: ${f.name}…` : `Reading ${f.name}…`);
        const urlRes = await fetch(`/api/clients/${clientLinkId}/statements/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: f.name, size: f.size, content_type: f.type }),
        });
        const urlJson = await urlRes.json();
        if (!urlRes.ok) throw new Error(urlJson.error || `Couldn't prepare upload for ${f.name}`);

        const { error: upErr } = await supabase.storage
          .from(CLIENT_UPLOADS_BUCKET)
          .uploadToSignedUrl(urlJson.path, urlJson.token, f);
        if (upErr) throw new Error(`Upload failed for ${f.name}: ${upErr.message}`);

        const procRes = await fetch(`/api/clients/${clientLinkId}/statements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: urlJson.path, name: f.name }),
        });
        const procJson = await procRes.json();
        if (!procRes.ok) throw new Error(procJson.error || `Couldn't read ${f.name}`);
      }
      await load();
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <section className="rounded-2xl border-2 border-teal-border bg-gradient-to-br from-teal/60 to-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-teal-light flex-shrink-0">
            <FileText size={20} className="text-teal-dark" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-navy flex items-center gap-1.5">
              Statements <Sparkles size={13} className="text-teal-light" />
            </h3>
            <p className="text-xs text-ink-slate mt-0.5">
              Upload bank, credit-card or loan statements — AI identifies the account, matches it to QuickBooks, and files it by month.
            </p>
          </div>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 bg-navy hover:bg-navy-deep disabled:opacity-60 text-white text-sm font-semibold px-3 py-2 rounded-lg flex-shrink-0"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-sm text-teal-dark bg-teal-light border border-teal-border rounded-lg px-3 py-2">
          <Loader2 size={14} className="animate-spin" /> {busy}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink-light"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : statements.length === 0 ? (
          <p className="text-sm text-ink-light italic">No statements filed yet.</p>
        ) : (
          (() => {
            // Group by account (matched account, else the parsed account label,
            // else "Unmatched"), each group collapsible. Within a group, sort by
            // year+month per the sort toggle.
            const groups = new Map<string, Statement[]>();
            for (const s of statements) {
              const key = s.matched_account_name || s.account_label || "Unmatched";
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(s);
            }
            const sortVal = (s: Statement) => (s.period_year || 0) * 100 + (s.period_month || 0);
            const dir = sortDir === "desc" ? -1 : 1;
            const groupKeys = [...groups.keys()].sort((a, b) => {
              if (a === "Unmatched") return 1;
              if (b === "Unmatched") return -1;
              return a.localeCompare(b);
            });
            return (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-ink-slate">
                    {statements.length} statement{statements.length === 1 ? "" : "s"} across {groups.size} account{groups.size === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-slate hover:text-navy"
                    title="Sort statements by year"
                  >
                    <ArrowDownUp size={12} /> {sortDir === "desc" ? "Newest first" : "Oldest first"}
                  </button>
                </div>
                <div className="space-y-2">
                  {groupKeys.map((key) => {
                    const rows = [...groups.get(key)!].sort((a, b) => (sortVal(a) - sortVal(b)) * dir);
                    const isCollapsed = !expanded.has(key);
                    const last4 = rows.find((r) => r.last4)?.last4;
                    const years = [...new Set(rows.map((r) => r.period_year).filter(Boolean))].sort();
                    const yearSpan = years.length ? (years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`) : "";
                    return (
                      <div key={key} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                        <button
                          type="button"
                          onClick={() => toggleGroup(key)}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-teal-light/40 hover:bg-teal-light text-left"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {isCollapsed ? <ChevronRight size={14} className="text-ink-slate" /> : <ChevronDown size={14} className="text-ink-slate" />}
                            <span className="text-sm font-semibold text-navy truncate">
                              {key === "Unmatched" ? <span className="text-amber-700">Unmatched</span> : key}
                            </span>
                            {last4 && <span className="text-[11px] text-ink-slate">•••{last4}</span>}
                          </span>
                          <span className="text-[11px] text-ink-slate whitespace-nowrap">
                            {rows.length} · {yearSpan}
                          </span>
                        </button>
                        {!isCollapsed && (
                          <table className="w-full text-sm">
                            <tbody className="divide-y divide-gray-100">
                              {rows.map((s) => {
                                const conf = CONF[s.match_confidence || "none"] || CONF.none;
                                return (
                                  <tr key={s.id} className="bg-white hover:bg-teal-light/30">
                                    <td className="px-3 py-2.5">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <FileText size={16} className="text-teal-dark flex-shrink-0" />
                                        <button
                                          type="button"
                                          onClick={() => setPreview({ path: s.storage_path, name: s.display_name })}
                                          className="text-sm font-semibold text-navy truncate max-w-[220px] text-left hover:text-teal-dark hover:underline"
                                          title="Click to preview"
                                        >
                                          {s.display_name}
                                        </button>
                                        {s.uploaded_via === "portal" && <span className="text-[11px] text-teal-dark">client upload</span>}
                                      </div>
                                    </td>
                                    <td className="px-3 py-2.5 text-sm text-ink-slate whitespace-nowrap">{periodLabel(s)}</td>
                                    <td className="px-3 py-2.5 hidden md:table-cell text-sm text-ink-slate whitespace-nowrap">{statementEndLabel(s)}</td>
                                    <td className="px-3 py-2.5 text-right text-sm font-mono text-navy whitespace-nowrap">{formatStatementBalance(s.ending_balance)}</td>
                                    <td className="px-3 py-2.5">
                                      <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border whitespace-nowrap ${conf.cls}`}>
                                        {s.status === "processed" && s.match_confidence === "high"
                                          ? <span className="inline-flex items-center gap-1"><CheckCircle2 size={10} /> {conf.label}</span>
                                          : conf.label}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                      <button
                                        type="button"
                                        onClick={() => setPreview({ path: s.storage_path, name: s.display_name })}
                                        className="inline-flex p-1.5 rounded-md hover:bg-gray-100 text-ink-slate"
                                        title="Preview"
                                      >
                                        <Eye size={15} />
                                      </button>
                                      <a
                                        href={`/api/client-files/download?path=${encodeURIComponent(s.storage_path)}`}
                                        className="inline-flex p-1.5 rounded-md hover:bg-gray-100 text-ink-slate"
                                        title="Download original"
                                      >
                                        <Download size={15} />
                                      </a>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()
        )}
      </div>

      {preview && (
        <FilePreviewModal
          path={preview.path}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}
