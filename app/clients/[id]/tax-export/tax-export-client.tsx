"use client";

import { useEffect, useState } from "react";
import { Download, FileText, Landmark, Loader2, Play } from "lucide-react";

/**
 * Year-end tax export UI. Fiscal year defaults to the last completed
 * Dec 31 year; the date inputs allow any custom range. Everything renders
 * from one GET — downloads are generated client-side (CSV blobs).
 */

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function TaxExportClient({
  clientLinkId,
  clientName,
  jurisdiction,
}: {
  clientLinkId: string;
  clientName: string;
  jurisdiction: string;
}) {
  const lastFY = new Date().getFullYear() - 1;
  const [start, setStart] = useState(`${lastFY}-01-01`);
  const [end, setEnd] = useState(`${lastFY}-12-31`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<any | null>(null);
  const [vehiclePct, setVehiclePct] = useState(100);
  const [homeOffice, setHomeOffice] = useState(0);
  const [notes, setNotes] = useState<any[] | null>(null);
  const [notesBusy, setNotesBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/tax-export?start=${start}&end=${end}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e: any) {
      setError(e?.message || "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadNotes() {
    setNotesBusy(true);
    try {
      const fy = new Date(end).getFullYear();
      const res = await fetch(`/api/tax-notes?client_link_id=${clientLinkId}&fy=${fy}`);
      const j = await res.json();
      setNotes(res.ok ? j.notes || [] : []);
    } catch {
      setNotes([]);
    } finally {
      setNotesBusy(false);
    }
  }

  const slug = clientName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const t = data?.t2125;
  const vehicleDisallowed = t ? Math.round(t.vehicle_total * (1 - vehiclePct / 100) * 100) / 100 : 0;
  const adjustedNet = t
    ? Math.round((t.net_before_adjustments + t.meals_disallowed * 0 + vehicleDisallowed - homeOffice) * 100) / 100
    : 0;

  return (
    <>
      <div className="bg-white rounded-2xl border border-gray-100 p-5 flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Fiscal year start</label>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5" />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">Fiscal year end</label>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5" />
        </div>
        <button
          onClick={() => { setStart(`${lastFY}-01-01`); setEnd(`${lastFY}-12-31`); }}
          className="text-xs font-semibold text-ink-slate border border-gray-200 rounded-lg px-2.5 py-2 hover:border-teal"
        >
          Dec 31, {lastFY}
        </button>
        <div className="flex-1" />
        <button
          onClick={run}
          disabled={busy}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          {busy ? "Pulling year-end…" : "Generate export"}
        </button>
      </div>
      {error && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-800">{error}</div>}

      {data && (
        <>
          {data.unmapped?.length > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-300 px-4 py-3 text-sm text-amber-900">
              <strong>{data.unmapped.length} account{data.unmapped.length === 1 ? "" : "s"} have no GIFI code</strong> and are
              excluded from the files below — map them on the Tax Exports page first:{" "}
              {data.unmapped.slice(0, 6).map((u: any) => `${u.account} (${money(u.amount)})`).join(" · ")}
              {data.unmapped.length > 6 ? "…" : ""}
            </div>
          )}

          {/* T2 — GIFI */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
              <Landmark size={15} className="text-teal" />
              <h3 className="text-sm font-bold text-navy uppercase tracking-wider">T2 · GIFI</h3>
              <span className="text-[11px] text-ink-light">imports into ProFile / TaxPrep / CanTax / TaxCycle</span>
              <div className="flex-1" />
              <button
                onClick={() =>
                  downloadCsv(`${slug}-gifi-${end}.csv`, [
                    ["GIFI code", "Description", "Amount"],
                    ...data.gifi_pl.map((r: any) => [r.code, r.label, r.amount]),
                    ...data.gifi_bs.map((r: any) => [r.code, r.label, r.amount]),
                  ])
                }
                className="inline-flex items-center gap-1.5 text-xs font-bold text-teal border border-teal/30 rounded-lg px-2.5 py-1.5 hover:bg-teal/5"
              >
                <Download size={12} /> GIFI CSV
              </button>
            </div>
            <div className="grid md:grid-cols-2 divide-x divide-gray-50">
              {[["Income statement (S125)", data.gifi_pl], ["Balance sheet (S100)", data.gifi_bs]].map(([title, rows]: any) => (
                <div key={title} className="p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2">{title}</div>
                  <table className="w-full text-xs">
                    <tbody>
                      {rows.map((r: any) => (
                        <tr key={r.code} className="border-b border-gray-50">
                          <td className="py-1 font-mono text-ink-slate w-14">{r.code}</td>
                          <td className="py-1 text-navy">{r.label}</td>
                          <td className="py-1 text-right font-mono text-navy">{money(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>

          {/* T1 — T2125 */}
          {t && (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
                <FileText size={15} className="text-teal" />
                <h3 className="text-sm font-bold text-navy uppercase tracking-wider">T1 · T2125 sheet</h3>
                <span className="text-[11px] text-ink-light">line-mapped, key straight into the T1 module</span>
                <div className="flex-1" />
                <button
                  onClick={() =>
                    downloadCsv(`${slug}-t2125-${end}.csv`, [
                      ["Line", "Label", "Amount"],
                      ["", "Gross sales", t.gross],
                      ["", "Cost of goods sold", t.cogs],
                      ["", "Gross profit", t.gross_profit],
                      ...t.expenses.map((e: any) => [e.code, e.label, e.amount]),
                      ["", "Vehicle personal-use add-back", vehicleDisallowed],
                      ["", "Home-office deduction (entered)", homeOffice],
                      ["", "Net income before other adjustments", adjustedNet],
                    ])
                  }
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-teal border border-teal/30 rounded-lg px-2.5 py-1.5 hover:bg-teal/5"
                >
                  <Download size={12} /> T2125 CSV
                </button>
              </div>
              <div className="p-4 space-y-3">
                <table className="w-full text-xs">
                  <tbody>
                    <tr className="border-b border-gray-100"><td className="py-1 text-navy font-semibold">Gross sales</td><td /><td className="py-1 text-right font-mono">{money(t.gross)}</td></tr>
                    <tr className="border-b border-gray-100"><td className="py-1 text-navy">Cost of goods sold (labour, materials, subs)</td><td /><td className="py-1 text-right font-mono">({money(t.cogs)})</td></tr>
                    <tr className="border-b border-gray-100"><td className="py-1 text-navy font-semibold">Gross profit</td><td /><td className="py-1 text-right font-mono">{money(t.gross_profit)}</td></tr>
                    {t.expenses.map((e: any) => (
                      <tr key={e.code} className="border-b border-gray-50">
                        <td className="py-1 text-navy">{e.label}</td>
                        <td className="py-1 font-mono text-ink-light text-right pr-3">{e.code}</td>
                        <td className="py-1 text-right font-mono">({money(e.amount)})</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 space-y-2 text-xs">
                  <div className="font-bold text-navy uppercase tracking-wider text-[10px]">Adjustments (preparer inputs)</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-ink-slate">Meals 50% limitation:</span>
                    <span className="font-mono text-navy">{money(t.meals_disallowed)} disallowed</span>
                    <span className="text-ink-light">(auto — {money(t.meals_total)} booked, 50% shown in the expense line)</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-ink-slate">Vehicle business-use:</span>
                    <input type="number" min={0} max={100} value={vehiclePct} onChange={(e) => setVehiclePct(Math.min(100, Math.max(0, Number(e.target.value))))} className="w-16 text-xs border border-gray-200 rounded px-1.5 py-1" />
                    <span className="text-ink-slate">% → add back <span className="font-mono text-navy">{money(vehicleDisallowed)}</span> of {money(t.vehicle_total)} booked</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-ink-slate">Home-office deduction (business-use-of-home, preparer computed):</span>
                    <input type="number" min={0} value={homeOffice} onChange={(e) => setHomeOffice(Math.max(0, Number(e.target.value)))} className="w-24 text-xs border border-gray-200 rounded px-1.5 py-1" />
                  </div>
                  <div className="pt-1 border-t border-gray-200 font-semibold text-navy">
                    Net income after adjustments: <span className="font-mono">{money(adjustedNet)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* T5018 */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-navy uppercase tracking-wider">T5018 · subcontractor totals</h3>
              <span className="text-[11px] text-ink-light">one slip per vendor — from the subcontract accounts</span>
              <div className="flex-1" />
              {data.t5018?.length > 0 && (
                <button
                  onClick={() => downloadCsv(`${slug}-t5018-${end}.csv`, [["Vendor", "Total paid"], ...data.t5018.map((v: any) => [v.vendor, v.total])])}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-teal border border-teal/30 rounded-lg px-2.5 py-1.5 hover:bg-teal/5"
                >
                  <Download size={12} /> T5018 CSV
                </button>
              )}
            </div>
            {data.t5018?.length === 0 ? (
              <div className="px-5 py-4 text-xs text-ink-light">No subcontractor payments in this period.</div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {data.t5018.map((v: any) => (
                    <tr key={v.vendor} className="border-b border-gray-50">
                      <td className="px-5 py-1.5 text-navy">{v.vendor}</td>
                      <td className="px-5 py-1.5 text-right font-mono text-navy">{money(v.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Jurisdiction notes */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <h3 className="text-sm font-bold text-navy uppercase tracking-wider">
                {jurisdiction} tax notes · FY {new Date(end).getFullYear()}
              </h3>
              <span className="text-[11px] text-ink-light">government sources only</span>
              <div className="flex-1" />
              <button
                onClick={loadNotes}
                disabled={notesBusy}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-teal border border-teal/30 rounded-lg px-2.5 py-1.5 hover:bg-teal/5 disabled:opacity-50"
              >
                {notesBusy ? <Loader2 size={12} className="animate-spin" /> : null}
                {notes === null ? "Load notes" : "Refresh"}
              </button>
            </div>
            {notes === null ? (
              <div className="px-5 py-4 text-xs text-ink-light">Click Load notes — first load researches CRA/provincial sites (~30s), then it&apos;s cached for the year.</div>
            ) : notes.length === 0 ? (
              <div className="px-5 py-4 text-xs text-ink-light">No notes returned — try Refresh.</div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {notes.map((n: any, i: number) => (
                  <li key={i} className="px-5 py-3">
                    <div className="text-sm font-semibold text-navy">{n.title} <span className="text-[10px] font-bold text-ink-light">{n.applies_to}</span></div>
                    <div className="text-xs text-ink-slate mt-0.5">{n.detail}</div>
                    {n.source_url && (
                      <a href={n.source_url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-teal hover:underline">{n.source_url}</a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-[11px] text-ink-light">
            Accrual basis · generated from the closed books · review material for the preparer, not a filing.
          </p>
        </>
      )}
    </>
  );
}
