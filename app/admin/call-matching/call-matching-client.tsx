"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Video, ExternalLink, Loader2, Check, X, Link2, Sparkles, EyeOff, Undo2,
} from "lucide-react";

interface Participant { name: string | null; email: string | null }
interface Match { client_link_id: string; match_method: string; client_name: string }
interface Recording {
  id: string;
  title: string;
  url: string | null;
  start_datetime: string | null;
  duration: string | null;
  summary: string | null;
  host_name: string | null;
  ignored: boolean;
  participants: Participant[];
  matches: Match[];
}
interface Client { id: string; name: string }

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

const METHOD_LABEL: Record<string, string> = {
  manual: "manual", auto_rule: "rule", auto_email: "email", auto_name: "name",
};

export function CallMatchingClient({
  unmatched, matched, ignored, clients,
}: {
  unmatched: Recording[]; matched: Recording[]; ignored: Recording[]; clients: Client[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"unmatched" | "matched" | "ignored">("unmatched");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(recordingId: string, action: string, clientLinkId?: string) {
    setBusy(recordingId);
    setError(null);
    try {
      const res = await fetch("/api/admin/grain/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recording_id: recordingId, action, client_link_id: clientLinkId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const list = tab === "unmatched" ? unmatched : tab === "matched" ? matched : ignored;

  return (
    <div className="max-w-4xl">
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
        {([
          ["unmatched", `Unmatched (${unmatched.length})`],
          ["matched", `Matched (${matched.length})`],
          ["ignored", `Ignored (${ignored.length})`],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${
              tab === k ? "border-teal text-teal" : "border-transparent text-ink-slate hover:text-navy"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="text-sm text-ink-slate italic py-10 text-center">
          {tab === "unmatched" ? "Nothing waiting — every Ironbooks call is matched or ignored. 🎉" : "Nothing here."}
        </div>
      ) : (
        <ul className="space-y-3">
          {list.map((rec) => (
            <RecordingRow
              key={rec.id}
              rec={rec}
              clients={clients}
              tab={tab}
              busy={busy === rec.id}
              onAct={act}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RecordingRow({
  rec, clients, tab, busy, onAct,
}: {
  rec: Recording; clients: Client[]; tab: string; busy: boolean;
  onAct: (id: string, action: string, clientId?: string) => void;
}) {
  const [pick, setPick] = useState("");

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 relative">
      {busy && (
        <div className="absolute inset-0 bg-white/60 rounded-xl flex items-center justify-center z-10">
          <Loader2 className="animate-spin text-teal" size={18} />
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Video size={14} className="text-teal flex-shrink-0" />
            <span className="font-semibold text-sm text-navy truncate">{rec.title}</span>
            {rec.url && (
              <a href={rec.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-teal hover:underline inline-flex items-center gap-0.5 flex-shrink-0">
                watch <ExternalLink size={10} />
              </a>
            )}
          </div>
          <div className="text-[11px] text-ink-slate mt-0.5">
            {fmtDate(rec.start_datetime)}{rec.duration ? ` · ${rec.duration}` : ""}{rec.host_name ? ` · Host: ${rec.host_name}` : ""}
          </div>
          {/* Participants (non-ironbooks) — the matching signal */}
          {rec.participants.length > 0 && (
            <div className="text-[11px] text-ink-slate mt-1.5 flex flex-wrap gap-1">
              {rec.participants.map((p, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded bg-slate-100">
                  {p.name || p.email}{p.name && p.email ? ` · ${p.email}` : ""}
                </span>
              ))}
            </div>
          )}
          {/* Existing matches */}
          {rec.matches.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {rec.matches.map((m) => (
                <span key={m.client_link_id} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <Link2 size={11} /> {m.client_name}
                  <span className="opacity-60">· {METHOD_LABEL[m.match_method] || m.match_method}</span>
                  <button onClick={() => onAct(rec.id, "unmatch", m.client_link_id)} className="ml-0.5 hover:text-red-600" title="Remove match">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {rec.summary && (
            <p className="text-xs text-ink-slate mt-2 line-clamp-2 leading-relaxed">{rec.summary}</p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="text-xs rounded-lg border border-slate-200 px-2 py-1.5 text-navy bg-white max-w-[240px]"
        >
          <option value="">Match to client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          onClick={() => pick && onAct(rec.id, "match", pick)}
          disabled={!pick}
          className="inline-flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-lg bg-teal text-white hover:bg-teal-dark disabled:opacity-40"
        >
          <Sparkles size={12} /> Match {tab !== "matched" && "+ learn rule"}
        </button>
        {tab !== "ignored" ? (
          <button
            onClick={() => onAct(rec.id, "ignore")}
            className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-ink-slate hover:bg-gray-50"
          >
            <EyeOff size={12} /> Not a client
          </button>
        ) : (
          <button
            onClick={() => onAct(rec.id, "unignore")}
            className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-ink-slate hover:bg-gray-50"
          >
            <Undo2 size={12} /> Restore
          </button>
        )}
      </div>
    </li>
  );
}
