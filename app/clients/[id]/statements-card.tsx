"use client";

import { useEffect, useRef, useState } from "react";
import {
  FileText, Upload, Loader2, Download, CheckCircle2, AlertTriangle, Sparkles,
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    <section className="rounded-2xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/60 to-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-indigo-100 flex-shrink-0">
            <FileText size={20} className="text-indigo-600" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-navy flex items-center gap-1.5">
              Statements <Sparkles size={13} className="text-indigo-400" />
            </h3>
            <p className="text-xs text-ink-slate mt-0.5">
              Upload bank, credit-card or loan statements — AI identifies the account, matches it to QuickBooks, and files it by month.
            </p>
          </div>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold px-3 py-2 rounded-lg flex-shrink-0"
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
        <div className="mt-3 flex items-center gap-2 text-sm text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
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
          <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead className="bg-indigo-50/60">
                <tr className="text-[11px] uppercase tracking-wide text-ink-slate">
                  <th className="text-left font-semibold px-3 py-2">Statement</th>
                  <th className="text-left font-semibold px-3 py-2">Applied to account</th>
                  <th className="text-left font-semibold px-3 py-2 hidden sm:table-cell">Period</th>
                  <th className="text-left font-semibold px-3 py-2">Match</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {statements.map((s) => {
                  const conf = CONF[s.match_confidence || "none"] || CONF.none;
                  return (
                    <tr key={s.id} className="bg-white hover:bg-indigo-50/30">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText size={16} className="text-indigo-500 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-navy truncate max-w-[220px]">{s.display_name}</div>
                            <div className="text-xs text-ink-slate flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              {s.last4 && <span>•••{s.last4}</span>}
                              {s.uploaded_via === "portal" && <span className="text-indigo-500">client upload</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {s.matched_account_name
                          ? <span className="text-sm text-navy">{s.matched_account_name}</span>
                          : <span className="text-sm text-amber-700 font-medium">Not applied yet</span>}
                      </td>
                      <td className="px-3 py-2.5 hidden sm:table-cell text-sm text-ink-slate whitespace-nowrap">{periodLabel(s)}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border whitespace-nowrap ${conf.cls}`}>
                          {s.status === "processed" && s.match_confidence === "high"
                            ? <span className="inline-flex items-center gap-1"><CheckCircle2 size={10} /> {conf.label}</span>
                            : conf.label}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
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
          </div>
        )}
      </div>
    </section>
  );
}
