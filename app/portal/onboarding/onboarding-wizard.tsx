"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PlayCircle, ClipboardList, Upload, CheckCircle2, Loader2, ArrowRight, ArrowLeft } from "lucide-react";
import type { PortalOnboardingState } from "@/lib/portal-onboarding";

type Foundation = {
  legal_business_name: string; trade_type: string; entity_type: string;
  fiscal_year_end: string; payroll_provider: string; prior_bookkeeper: string;
  accounting_software: string; employee_count_range: string;
  contact_first_name: string; contact_last_name: string; client_phone: string; state_province: string;
};

const ENTITY_OPTIONS_US = [
  { v: "c_corp", l: "C-Corporation" }, { v: "s_corp", l: "S-Corporation" },
  { v: "partnership", l: "Partnership" }, { v: "sole_prop", l: "Sole Proprietor" },
];
const ENTITY_OPTIONS_CA = [
  { v: "c_corp", l: "Corporation" }, { v: "partnership", l: "Partnership" }, { v: "sole_prop", l: "Sole Proprietor" },
];
const EMPLOYEE_OPTIONS = ["Just me (owner-operator)", "2–5", "6–15", "16–30", "30+"];

export function OnboardingWizard({
  clientName, jurisdiction, videoUrl, initial, state, docRequests,
}: {
  clientName: string;
  jurisdiction: string;
  videoUrl: string;
  initial: Foundation;
  state: PortalOnboardingState;
  docRequests: Array<{ label: string }>;
}) {
  const router = useRouter();
  const isCA = String(jurisdiction).toUpperCase().startsWith("CA");
  const entityOptions = isCA ? ENTITY_OPTIONS_CA : ENTITY_OPTIONS_US;

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Foundation>(initial);
  const [attested, setAttested] = useState(!!state.accounts_attested);
  const [videoDone, setVideoDone] = useState(!!state.video_watched_at);
  const [formDone, setFormDone] = useState(!!state.form_submitted_at);
  const [docsDone, setDocsDone] = useState(!!state.docs_provided_at);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (k: keyof Foundation, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function post(payload: any): Promise<boolean> {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/portal/onboarding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Something went wrong");
      return true;
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const steps = [
    { icon: PlayCircle, label: "Welcome", done: videoDone },
    { icon: ClipboardList, label: "Your business", done: formDone },
    { icon: Upload, label: "Documents", done: docsDone },
  ];

  async function markVideo() { if (await post({ action: "watch_video" })) { setVideoDone(true); setStep(1); } }
  async function submitForm() {
    if (!form.legal_business_name.trim() || !form.entity_type) {
      setError("Business name and entity type are required."); return;
    }
    if (await post({ action: "submit_form", ...form, accounts_attested: attested })) { setFormDone(true); setStep(2); }
  }
  async function ackDocs() { if (await post({ action: "ack_docs" })) { setDocsDone(true); await finish(); } }
  async function finish() { if (await post({ action: "complete" })) router.push("/portal"); }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy">Welcome to Ironbooks, {clientName.split(/[ ,]/)[0]} 👋</h1>
        <p className="text-sm text-ink-slate mt-1">A quick 3-step setup so we can get your books right. Takes about 5 minutes.</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {steps.map((s, i) => {
          const Icon = s.done ? CheckCircle2 : s.icon;
          const active = i === step;
          return (
            <button key={i} onClick={() => setStep(i)}
              className={`flex-1 flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                active ? "border-teal bg-teal-lighter" : s.done ? "border-emerald-200 bg-emerald-50" : "border-gray-200 bg-white"}`}>
              <Icon size={16} className={s.done ? "text-emerald-600" : active ? "text-teal" : "text-ink-light"} />
              <span className={`text-xs font-bold ${active ? "text-teal" : s.done ? "text-emerald-700" : "text-ink-slate"}`}>
                {i + 1}. {s.label}
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}

      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        {/* STEP 0 — video */}
        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-navy">Watch this 2-minute intro</h2>
            <p className="text-sm text-ink-slate">Here's how Ironbooks works and what we'll do for you.</p>
            <div className="aspect-video w-full rounded-xl overflow-hidden bg-navy/90 flex items-center justify-center">
              {videoUrl ? (
                <iframe src={videoUrl} title="Ironbooks onboarding" className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
              ) : (
                <div className="text-white/70 text-sm flex flex-col items-center gap-2"><PlayCircle size={40} /><span>Intro video coming soon.</span></div>
              )}
            </div>
            <div className="flex justify-end">
              <button onClick={markVideo} disabled={busy}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} Next: your business
              </button>
            </div>
          </div>
        )}

        {/* STEP 1 — foundation intake */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-navy">Tell us about your business</h2>
            <p className="text-sm text-ink-slate">This replaces the old intake form — it goes straight to your bookkeeper.</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Legal business name" v={form.legal_business_name} on={(x) => set("legal_business_name", x)} required />
              <div>
                <Lbl>Entity type <span className="text-red-500">*</span></Lbl>
                <select value={form.entity_type} onChange={(e) => set("entity_type", e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-navy focus:border-teal outline-none">
                  <option value="">Select…</option>
                  {entityOptions.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>
              <Field label="What does your business do?" v={form.trade_type} on={(x) => set("trade_type", x)} placeholder="e.g. Painting contractor" />
              <Field label="Fiscal year-end" v={form.fiscal_year_end} on={(x) => set("fiscal_year_end", x)} placeholder="e.g. December 31" />
              <Field label="Payroll provider (if any)" v={form.payroll_provider} on={(x) => set("payroll_provider", x)} placeholder="e.g. Gusto, ADP, none" />
              <SelectField label="Number of employees" v={form.employee_count_range} on={(x) => set("employee_count_range", x)} options={EMPLOYEE_OPTIONS} />
              <Field label="Prior bookkeeper / accountant" v={form.prior_bookkeeper} on={(x) => set("prior_bookkeeper", x)} />
              <Field label="Accounting software" v={form.accounting_software} on={(x) => set("accounting_software", x)} placeholder="e.g. QuickBooks Online" />
              <Field label="Contact first name" v={form.contact_first_name} on={(x) => set("contact_first_name", x)} />
              <Field label="Contact last name" v={form.contact_last_name} on={(x) => set("contact_last_name", x)} />
              <Field label="Phone" v={form.client_phone} on={(x) => set("client_phone", x)} />
              <Field label="Province / State" v={form.state_province} on={(x) => set("state_province", x)} />
            </div>
            <label className="flex items-start gap-2.5 bg-teal-lighter/60 border border-teal/15 rounded-xl px-3 py-3 cursor-pointer">
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 w-4 h-4 rounded border-2 border-gray-300 text-teal focus:ring-teal" />
              <span className="text-xs text-navy leading-relaxed">I confirm the bank, credit-card, and loan accounts connected to my bookkeeping are <strong>all</strong> of my business accounts — there are no other accounts or loans we've missed.</span>
            </label>
            <div className="flex justify-between">
              <button onClick={() => setStep(0)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy"><ArrowLeft size={15} /> Back</button>
              <button onClick={submitForm} disabled={busy}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} Save &amp; continue
              </button>
            </div>
          </div>
        )}

        {/* STEP 2 — documents */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-navy">Send us your documents</h2>
            <p className="text-sm text-ink-slate">
              {docRequests.length > 0
                ? "Here's what we need to get your books accurate. Upload them in Messages, or reply to our email with the files attached."
                : "Your bookkeeper will request any documents they need shortly. You can finish setup now."}
            </p>
            {docRequests.length > 0 && (
              <ul className="rounded-xl border border-gray-200 divide-y divide-gray-50">
                {docRequests.map((d, i) => (
                  <li key={i} className="px-4 py-2.5 text-sm text-navy flex items-start gap-2">
                    <ClipboardList size={14} className="text-teal mt-0.5 flex-shrink-0" /> {d.label}
                  </li>
                ))}
              </ul>
            )}
            <Link href="/portal/messages" className="inline-flex items-center gap-2 text-sm font-semibold text-teal border border-teal/30 rounded-lg px-4 py-2.5 hover:bg-teal/5">
              <Upload size={15} /> Upload documents in Messages
            </Link>
            <div className="flex justify-between items-center pt-2">
              <button onClick={() => setStep(1)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy"><ArrowLeft size={15} /> Back</button>
              <button onClick={ackDocs} disabled={busy}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} I've sent my documents — finish
              </button>
            </div>
            <p className="text-[11px] text-ink-light text-center">Haven't got them all yet? Finish anyway — we'll follow up in Messages.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-slate mb-1">{children}</label>;
}
function Field({ label, v, on, placeholder, required }: { label: string; v: string; on: (x: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <div>
      <Lbl>{label}{required && <span className="text-red-500"> *</span>}</Lbl>
      <input value={v} onChange={(e) => on(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-navy focus:border-teal outline-none" />
    </div>
  );
}
function SelectField({ label, v, on, options }: { label: string; v: string; on: (x: string) => void; options: string[] }) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      <select value={v} onChange={(e) => on(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-navy focus:border-teal outline-none">
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
