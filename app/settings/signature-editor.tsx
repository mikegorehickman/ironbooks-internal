"use client";

import { useState } from "react";
import { Loader2, Save, Mail } from "lucide-react";
import { renderUserSignature, type SignatureUser } from "@/lib/user-signature";

export function SignatureEditor({ initial }: { initial: SignatureUser }) {
  const [title, setTitle] = useState(initial.title || "");
  const [phone, setPhone] = useState(initial.phone || "");
  const [booking, setBooking] = useState(initial.booking_url || "");
  const [enabled, setEnabled] = useState(initial.signature_enabled !== false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const preview = renderUserSignature({
    full_name: initial.full_name, email: initial.email, avatar_url: initial.avatar_url,
    title, phone, booking_url: booking, signature_enabled: enabled,
  });

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const res = await fetch("/api/me/profile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, phone, booking_url: booking, signature_enabled: enabled }),
      });
      setMsg(res.ok ? "Saved." : "Couldn't save — try again.");
    } catch { setMsg("Network error."); } finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-1"><Mail size={15} className="text-teal" /><h2 className="text-sm font-bold text-navy">My email signature</h2></div>
        <p className="text-xs text-ink-slate mb-4">Appears on the emails you send to clients (e.g. bulk email). Name and photo come from your account.</p>

        <label className="inline-flex items-center gap-2 text-sm text-navy mb-4">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded border-gray-300 text-teal" />
          Include my signature on emails
        </label>

        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${enabled ? "" : "opacity-50 pointer-events-none"}`}>
          <Field label="Name (from account)"><input value={initial.full_name || ""} disabled className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-ink-slate" /></Field>
          <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior Bookkeeper" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" /></Field>
          <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" /></Field>
          <Field label="Booking link (optional)"><input value={booking} onChange={(e) => setBooking(e.target.value)} placeholder="https://cal.com/you" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" /></Field>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2 rounded-lg disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save signature
          </button>
          {msg && <span className="text-xs text-ink-slate">{msg}</span>}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2">Live preview</div>
        {enabled
          ? <div dangerouslySetInnerHTML={{ __html: preview }} />
          : <p className="text-xs text-ink-light italic">Signature is turned off — your emails won't include it.</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-ink-light mb-1">{label}</div>
      {children}
    </div>
  );
}
