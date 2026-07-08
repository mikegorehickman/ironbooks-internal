"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

/** Master-COA → GIFI mapping editor. Blank code = excluded from exports
 *  (and flagged loudly on every client's export until mapped). */
export function GifiMappingEditor() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/master-coa-gifi")
      .then((r) => r.json())
      .then((j) => setRows(j.accounts || []))
      .catch(() => setRows([]));
  }, []);

  async function save(id: string, code: string) {
    const res = await fetch("/api/admin/master-coa-gifi", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, gifi_code: code }),
    });
    if (res.ok) {
      setRows((p) => (p || []).map((r) => (r.id === id ? { ...r, gifi_code: code || null } : r)));
      setSavedId(id);
      setTimeout(() => setSavedId(null), 1500);
    } else {
      const j = await res.json().catch(() => ({}));
      alert(j.error || "Couldn't save");
    }
  }

  const unmapped = (rows || []).filter((r) => !r.gifi_code && !r.is_parent).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">GIFI mapping</h2>
        <span className="text-[11px] text-ink-light">
          master COA → 4-digit GIFI code · drives T2, T2125 grouping, and T5018 (8360)
        </span>
        {unmapped > 0 && (
          <span className="text-[10px] font-bold text-amber-800 bg-amber-100 rounded-full px-2 py-0.5">
            {unmapped} unmapped
          </span>
        )}
      </div>
      {rows === null ? (
        <div className="px-5 py-4 text-xs text-ink-slate flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> loading…
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`border-b border-gray-50 ${!r.gifi_code && !r.is_parent ? "bg-amber-50/40" : ""}`}>
                  <td className="px-5 py-1.5 text-navy">{r.account_name}{r.is_parent ? " *" : ""}</td>
                  <td className="px-3 py-1.5 text-ink-light">{r.section}</td>
                  <td className="px-3 py-1.5 text-ink-light">{r.jurisdiction}</td>
                  <td className="px-5 py-1.5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      {savedId === r.id && <Check size={11} className="text-emerald-600" />}
                      <input
                        defaultValue={r.gifi_code || ""}
                        placeholder="—"
                        maxLength={4}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v !== (r.gifi_code || "")) save(r.id, v);
                        }}
                        className="w-16 text-xs font-mono text-center border border-gray-200 rounded px-1.5 py-1"
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
