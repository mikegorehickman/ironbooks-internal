"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Upload, Loader2, CheckCircle2, AlertTriangle, HelpCircle, Eye } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";
import { DOCUMENTS_CHANGED_EVENT } from "./documents-panel";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import { statementEndLabel, formatStatementBalance } from "@/lib/statement-format";

type Req = { id: string; label: string; account_name: string | null; account_kind: string | null };
type Stmt = {
  id: string;
  display_name: string;
  original_name: string | null;
  status: string;
  matched_account_name: string | null;
  account_label: string | null;
  last4: string | null;
  period_month: number | null;
  period_year: number | null;
  statement_end_date: string | null;
  ending_balance: number | null;
  storage_path: string | null;
};
type Account = { id: string | null; name: string };

/**
 * Dedicated statement upload for the portal Messages page.
 *
 * Shows the bookkeeper's open requests as a self-clearing checklist; the
 * client drops their bank / credit-card / loan statement PDFs, each is read by
 * AI, matched to the right account, renamed, and filed. Anything the AI can't
 * match surfaces with an account picker so the client can place it themselves.
 */
export function StatementUploadPanel() {
  const [requests, setRequests] = useState<Req[]>([]);
  const [unmatched, setUnmatched] = useState<Stmt[]>([]);
  const [filed, setFiled] = useState<Stmt[]>([]);
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justFiled, setJustFiled] = useState<string[]>([]);
  const [matchSel, setMatchSel] = useState<Record<string, string>>({});
  const [matching, setMatching] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/portal/statements");
      const json = await res.json();
      if (res.ok) {
        const stmts: Stmt[] = json.statements || [];
        setRequests(json.requests || []);
        setUnmatched(stmts.filter((s) => s.status === "unmatched"));
        // Everything successfully filed (not awaiting a manual match, not
        // mid-processing or failed) — the client's browsable history.
        setFiled(stmts.filter((s) => !["unmatched", "failed", "processing"].includes(s.status)));
      }
    } catch {
      /* keep prior state */
    }
  }
  useEffect(() => { refresh(); }, []);

  // Load the account list lazily — only when there's something to match.
  useEffect(() => {
    if (unmatched.length > 0 && accounts.length === 0) {
      fetch("/api/portal/statement-accounts")
        .then((r) => r.json())
        .then((j) => setAccounts(j.accounts || []))
        .catch(() => {});
    }
  }, [unmatched.length, accounts.length]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setJustFiled([]);
    const files = Array.from(fileList);
    const supabase = createBrowserSupabase();
    const filed: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setBusy(files.length > 1 ? `Reading ${i + 1} of ${files.length}…` : "Reading your statement…");
        const urlRes = await fetch("/api/portal/messages/upload-url", {
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

        const procRes = await fetch("/api/portal/statements/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: urlJson.path, name: f.name }),
        });
        const procJson = await procRes.json();
        if (!procRes.ok) throw new Error(procJson.error || `Couldn't read ${f.name}`);
        filed.push(procJson.display_name || f.name);
      }
      setJustFiled(filed);
      await refresh();
      window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT));
    } catch (e: any) {
      setError(e?.message || "Something went wrong — try again");
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function matchStatement(stmtId: string) {
    const name = matchSel[stmtId];
    if (!name) return;
    setMatching(stmtId);
    setError(null);
    try {
      const acct = accounts.find((a) => a.name === name);
      const res = await fetch(`/api/portal/statements/${stmtId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_name: name, qbo_account_id: acct?.id || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't match — try again");
      await refresh();
      window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT));
    } catch (e: any) {
      setError(e?.message || "Couldn't match — try again");
    } finally {
      setMatching(null);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-cardline p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-teal/10 flex-shrink-0">
            <FileText size={18} className="text-teal" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-navy text-sm">Upload bank statements</h3>
            <p className="text-xs text-ink-slate mt-0.5 leading-relaxed">
              Drop your bank, credit-card or loan statement PDFs — we'll automatically figure out which account each one is and file it for your bookkeeper.
            </p>
          </div>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-3 py-2 rounded-lg flex-shrink-0"
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

      {/* Bookkeeper's open requests — a self-clearing checklist. */}
      {requests.length > 0 && (
        <div className="mt-4 rounded-lg border border-gold-border bg-gold-tint px-3 py-3">
          <div className="text-xs font-bold uppercase tracking-wide text-gold-deep">
            Your bookkeeper needs {requests.length} statement{requests.length === 1 ? "" : "s"}
          </div>
          <ul className="mt-2 space-y-1.5">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm text-gold-deep">
                <span className="w-4 h-4 rounded-full border-2 border-amber-400 flex-shrink-0" />
                <span>{r.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-gold-deep">These clear automatically as you upload each one.</p>
        </div>
      )}

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-sm text-teal-dark bg-teal/5 border border-teal/20 rounded-lg px-3 py-2">
          <Loader2 size={14} className="animate-spin" /> {busy}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-1.5 text-xs text-rust bg-rust-tint border border-rust-border rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}
      {justFiled.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {justFiled.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0" />
              <span className="truncate"><strong>{d}</strong> — filed for your bookkeeper</span>
            </li>
          ))}
        </ul>
      )}

      {/* AI couldn't match — let the client place it. */}
      {unmatched.length > 0 && (
        <div className="mt-4 rounded-lg border border-cardline bg-canvas px-3 py-3">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-slate">
            <HelpCircle size={13} /> Which account {unmatched.length === 1 ? "is this" : "are these"}?
          </div>
          <p className="text-[11px] text-ink-light mt-0.5">We couldn't tell automatically — pick the account so your bookkeeper can use it.</p>
          <ul className="mt-2 space-y-2">
            {unmatched.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-cardline bg-white px-3 py-2">
                <FileText size={14} className="text-ink-light flex-shrink-0" />
                <span className="text-sm text-navy flex-1 min-w-[120px] truncate">{s.original_name || s.display_name}</span>
                <select
                  value={matchSel[s.id] || ""}
                  onChange={(e) => setMatchSel((p) => ({ ...p, [s.id]: e.target.value }))}
                  className="text-sm rounded-lg border border-cardline bg-white px-2 py-1.5 text-navy max-w-[200px]"
                >
                  <option value="">Select account…</option>
                  {accounts.map((a) => (
                    <option key={a.name} value={a.name}>{a.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => matchStatement(s.id)}
                  disabled={!matchSel[s.id] || matching === s.id}
                  className="inline-flex items-center gap-1.5 bg-navy hover:bg-navy/90 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
                >
                  {matching === s.id ? <Loader2 size={12} className="animate-spin" /> : null}
                  Match
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filed statements — the client's browsable history with the period's
          ending balance + last statement date. Click a name to preview. */}
      {filed.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-bold uppercase tracking-wide text-ink-slate mb-2">
            Your filed statements
          </div>
          <div className="border border-cardline rounded-lg overflow-x-auto bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr className="text-[11px] uppercase tracking-wide text-ink-slate">
                  <th className="text-left font-semibold px-3 py-2">Statement</th>
                  <th className="text-left font-semibold px-3 py-2 hidden sm:table-cell">Account</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Statement date</th>
                  <th className="text-right font-semibold px-3 py-2 whitespace-nowrap">Ending balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filed.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2.5">
                      {s.storage_path ? (
                        <button
                          type="button"
                          onClick={() => setPreview({ path: s.storage_path!, name: s.display_name })}
                          className="inline-flex items-center gap-1.5 text-navy font-medium hover:text-teal-dark hover:underline text-left"
                          title="Click to preview"
                        >
                          <FileText size={14} className="text-teal shrink-0" />
                          <span className="truncate max-w-[200px]">{s.display_name}</span>
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-navy">
                          <FileText size={14} className="text-teal shrink-0" />
                          <span className="truncate max-w-[200px]">{s.display_name}</span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 hidden sm:table-cell text-ink-slate">
                      {s.matched_account_name || s.account_label || "—"}
                    </td>
                    <td className="px-3 py-2.5 text-ink-slate whitespace-nowrap">{statementEndLabel(s)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-navy whitespace-nowrap">
                      {formatStatementBalance(s.ending_balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview && (
        <FilePreviewModal
          path={preview.path}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
